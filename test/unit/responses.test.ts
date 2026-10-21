import { describe, expect, it } from 'vitest';
import { describeShape, diffShapes, lookup, successShape } from '../../src/core/shapes';
import type { ClientCall } from '../../src/core/types';
import { analyzeFiles, find } from '../helpers/memoryHost';

const reads = (c: ClientCall | undefined): string[] => (c?.reads ?? []).map((r) => r.path).sort();
const call = (calls: ClientCall[], url: string): ClientCall => {
  const c = calls.find((x) => x.url === url);
  if (!c) throw new Error(`No call to ${url} in ${calls.map((x) => x.url).join(', ')}`);
  return c;
};

describe('Response shapes inferred from handlers', () => {
  it('reads Express literals, statuses, local constants, mapped arrays and spreads', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `const express = require('express'); const app = express();
app.get('/users/:id', async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const body = { user: { id: user.id, fullName: user.name, active: true, tags: user.tags.map((t) => ({ label: t.name })) } };
  res.json(body);
});
app.get('/extra', (req, res) => res.json({ ok: 1, ...extra }));
app.delete('/users/:id', (req, res) => res.sendStatus(204));
module.exports = app;`,
    });
    const user = find(result.endpoints, 'GET', '/users/:id');
    expect(user.responses?.map((r) => r.status)).toEqual([404, undefined]);
    expect(describeShape(successShape(user))).toBe('{ user: { id, fullName, active, tags: { label }[] } }');
    expect(lookup(successShape(user)!, 'user.name')).toMatchObject({ found: 'absent', at: 'name' });
    expect(lookup(successShape(user)!, 'user.tags.[].label').found).toBe('present');
    // A spread of an unknown value: anything may be there.
    expect(lookup(successShape(find(result.endpoints, 'GET', '/extra'))!, 'anything').found).toBe('unknown');
    expect(find(result.endpoints, 'DELETE', '/users/:id').responses).toEqual([expect.objectContaining({ status: 204, via: 'status' })]);
  });

  it('reads handlers defined in other files, Koa ctx.body and Fastify return values', async () => {
    const { result } = await analyzeFiles({
      'src/controllers/users.js': `exports.show = async (req, res) => { res.status(200).json({ id: 1, name: 'x' }); };`,
      'src/app.js': `const express = require('express'); const app = express(); const users = require('./controllers/users');\napp.get('/users/:id', users.show);\nmodule.exports = app;`,
      'k/app.js': `const Koa = require('koa'); const Router = require('@koa/router'); const app = new Koa(); const r = new Router();\nr.get('/k', (ctx) => { ctx.status = 201; ctx.body = { created: true }; });\napp.use(r.routes());`,
      'f/app.js': `const fastify = require('fastify')();\nfastify.get('/f', async (request, reply) => { return { items: [] }; });`,
    });
    expect(describeShape(successShape(find(result.endpoints, 'GET', '/users/:id')))).toBe('{ id, name }');
    expect(find(result.endpoints, 'GET', '/k').responses?.map((r) => r.status ?? r.via)).toEqual([201, 'body']);
    expect(describeShape(successShape(find(result.endpoints, 'GET', '/f')))).toBe('{ items: [] }');
  });

  it('ignores what an Express handler returns', async () => {
    const { result } = await analyzeFiles({ 'src/app.js': `const app = require('express')();\napp.get('/x', (req, res) => { return { notSent: true }; });\nmodule.exports = app;` });
    expect(find(result.endpoints, 'GET', '/x').responses).toBeUndefined();
  });

  it('reads NestJS returns, thrown exceptions, @HttpCode and declared DTO types from other files', async () => {
    const { result } = await analyzeFiles({
      'src/users/user.dto.ts': `export class UserDto { id: number; fullName: string; @Exclude() password: string; profile?: { avatar: string } }`,
      'src/users/users.controller.ts': `import { Controller, Get, Post, HttpCode, Param, NotFoundException } from '@nestjs/common';
import { UserDto } from './user.dto';
@Controller('users')
export class UsersController {
  @Get(':id') async one(@Param('id') id: string): Promise<UserDto> { const u = await this.users.find(id); if (!u) throw new NotFoundException(); return u; }
  @Post() @HttpCode(202) create() { return { queued: true }; }
}`,
    });
    const one = find(result.endpoints, 'GET', '/users/:id');
    expect(one.responses?.map((r) => `${r.status} ${r.via}`)).toEqual(['404 throw', '200 type']);
    expect(describeShape(successShape(one))).toBe('{ id, fullName, profile?: { avatar } }');
    const create = find(result.endpoints, 'POST', '/users');
    expect(create.responses?.map((r) => r.status)).toEqual([202]);
  });

  it('builds Spring response shapes from DTO classes, records, Jackson annotations and wrappers', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/java/a/UserDto.java': `package a;\nimport com.fasterxml.jackson.annotation.*;\npublic class UserDto { private Long id; @JsonProperty("full_name") private String fullName; @JsonIgnore private String password; private List<Tag> tags; public String getDisplay() { return ""; } }`,
      'src/main/java/a/Tag.java': `package a;\npublic record Tag(String label, int weight) {}`,
      'src/main/java/a/UserController.java': `package a;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.*;
@RestController @RequestMapping("/users")
public class UserController {
  @GetMapping("/{id}") public ResponseEntity<UserDto> one(@PathVariable Long id) { return null; }
  @GetMapping public List<UserDto> all() { return null; }
  @PostMapping @ResponseStatus(HttpStatus.CREATED) public UserDto create(@RequestBody UserDto dto) { return dto; }
}`,
    });
    const one = find(result.endpoints, 'GET', '/users/{id}');
    expect(describeShape(successShape(one))).toBe('{ id, full_name, tags: { label, weight }[], display, … }');
    expect(lookup(successShape(one)!, 'password').found).not.toBe('present');
    expect(successShape(find(result.endpoints, 'GET', '/users'))?.t).toBe('array');
    expect(find(result.endpoints, 'POST', '/users').responses?.[0].status).toBe(201);
  });
});

describe('Shape diffs', () => {
  const obj = (props: Record<string, string>, open = false) => ({ t: 'object' as const, props: Object.fromEntries(Object.entries(props).map(([k, src]) => [k, { shape: { t: 'string' as const }, src }])), open });
  it('recognises renames by value expression and by name, removals and type changes', () => {
    expect(diffShapes(obj({ name: 'user.name', id: 'user.id' }), obj({ fullName: 'user.name', id: 'user.id' }))).toEqual([{ kind: 'renamed', path: 'name', to: 'fullName', evidence: 'both take their value from user.name' }]);
    expect(diffShapes(obj({ createdAt: 'a' }), obj({ created: 'b' }))).toEqual([expect.objectContaining({ kind: 'renamed', to: 'created', evidence: 'similar name in the same object' })]);
    expect(diffShapes(obj({ price: 'p', stock: 's' }), obj({ stock: 's' }))).toEqual([{ kind: 'removed', path: 'price', was: { t: 'string' } }]);
    const typed = diffShapes({ t: 'object', props: { stock: { shape: { t: 'number' } } } }, { t: 'object', props: { stock: { shape: { t: 'string' } } } });
    expect(typed).toEqual([{ kind: 'type', path: 'stock', from: 'number', to: 'string' }]);
  });

  it('does not claim removal from an open object', () => {
    expect(diffShapes(obj({ a: 'x', b: 'y' }), obj({ a: 'x' }, true))).toEqual([]);
  });
});

describe('Response fields read by client code', () => {
  const server = `const express = require('express'); const app = express();
app.get('/api/users/:id', (req, res) => res.json({ user: { id: 1, fullName: 'x' } }));
app.get('/api/items', (req, res) => res.json({ items: [{ title: 't' }] }));
module.exports = app;`;

  it('follows fetch, .then chains, axios destructuring and supertest bodies', async () => {
    const { result } = await analyzeFiles({
      'server/app.js': server,
      'web/a.js': `async function A(id) { const r = await fetch('/api/users/' + id); const d = await r.json(); return d.user.fullName; }`,
      'web/b.js': `import axios from 'axios';\nfunction B() { fetch('/api/items').then((r) => r.json()).then((d) => d.items.map((i) => i.title)); }\nasync function C() { const { data } = await axios.get('/api/users/1'); return data.user.id; }`,
      'server/app.test.js': `const request = require('supertest'); const app = require('./app');\nit('x', async () => { const res = await request(app).get('/api/users/1').expect(200); expect(res.body.user.id).toBe(1); });`,
    });
    expect(reads(call(result.clientCalls, "/api/users/${id}"))).toEqual(['user.fullName']);
    expect(reads(call(result.clientCalls, '/api/items'))).toEqual(['items.[].title']);
    expect(reads(call(result.clientCalls, '/api/users/1'))).toContain('user.id');
    expect(result.clientCalls.filter((c) => c.kind === 'test').flatMap((c) => c.reads?.map((r) => r.path) ?? [])).toEqual(['user.id']);
  });

  it('follows React state, react-query and service modules in other files', async () => {
    const { result } = await analyzeFiles({
      'server/package.json': '{}',
      'server/app.js': server,
      'web/package.json': '{}',
      'web/src/api/client.js': `import axios from 'axios';\nexport const api = axios.create({ baseURL: '/api' });`,
      'web/src/services/users.js': `import { api } from '../api/client';\nexport const userService = {\n  async get(id) { const res = await api.get(\`/users/\${id}\`); return res.data.user; },\n};\nexport async function listItems() { const { data } = await api.get('/items'); return data; }`,
      'web/src/components/Profile.jsx': `import { useEffect, useState } from 'react';\nimport { userService } from '../services/users';\nexport function Profile({ id }) {\n  const [user, setUser] = useState();\n  useEffect(() => { userService.get(id).then(setUser); userService.get(id).then((u) => setUser(u)); }, [id]);\n  return <h1>{user.fullName}</h1>;\n}`,
      'web/src/components/Items.jsx': `import { useQuery } from '@tanstack/react-query';\nimport { listItems } from '../services/users';\nexport function Items() {\n  const { data } = useQuery({ queryKey: ['items'], queryFn: () => listItems() });\n  return data.items.map((i) => <li key={i.title}>{i.name}</li>);\n}`,
    });
    const userCall = result.clientCalls.find((c) => c.url.includes('/users/'))!;
    expect(userCall.endpointIds).toHaveLength(1);
    expect(reads(userCall)).toContain('user.fullName');
    expect(userCall.consumers?.map((c) => c.within)).toContain('Profile');
    const items = result.clientCalls.find((c) => c.url.endsWith('/items'))!;
    expect(reads(items)).toEqual(expect.arrayContaining(['items.[].title', 'items.[].name']));
    // `name` is not in the items' shape: reported where it is read.
    const mismatches = result.issues.filter((i) => i.kind === 'response-mismatch');
    expect(mismatches.map((i) => i.message)).toEqual([expect.stringMatching(/`items\.\[\]\.name` is read in Items, but GET \/api\/items responds with/)]);
    expect(mismatches[0].location?.file).toMatch(/Items\.jsx$/);
  });

  it('does not track values unrelated to responses or report reads on unknown shapes', async () => {
    const { result } = await analyzeFiles({
      'server/app.js': `const app = require('express')();\napp.get('/api/u', async (req, res) => res.json(await db.find()));\nmodule.exports = app;`,
      'web/a.js': `async function A() { const config = { user: { x: 1 } }; config.user.y; const r = await fetch('/api/u'); const d = await r.json(); return d.whatever.deep; }`,
    });
    expect(reads(call(result.clientCalls, '/api/u'))).toEqual(['whatever.deep']);
    expect(result.issues.filter((i) => i.kind === 'response-mismatch')).toEqual([]);
  });

  it('skips the mismatch check for ambiguous calls', async () => {
    const { result } = await analyzeFiles({
      'server/app.js': `const app = require('express')();\napp.get('/a/:x', (req, res) => res.json({ one: 1 }));\napp.get('/:y/b', (req, res) => res.json({ two: 2 }));\nmodule.exports = app;`,
      'web/a.js': `async function A() { const d = await (await fetch('/a/b')).json(); return d.three; }`,
    });
    expect(call(result.clientCalls, '/a/b').endpointIds).toHaveLength(2);
    expect(result.issues.filter((i) => i.kind === 'response-mismatch')).toEqual([]);
  });
});

