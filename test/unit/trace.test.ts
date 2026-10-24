import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildDashboardModel, refTable } from '../../src/core/dashboardModel';
import type { Endpoint } from '../../src/core/types';
import { analyzeFiles, find, ROOT } from '../helpers/memoryHost';

const steps = (e: Endpoint): string[] => (e.trace ?? []).map((t) => `${t.text} @ ${t.location ? `${path.relative(ROOT, t.location.file)}:${t.location.line}` : '-'}`);

describe('How an endpoint path is built (trace)', () => {
  it('records Express mounts and registrations with their locations', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `const express = require('express');\nconst app = express();\nconst api = require('./api');\napp.use('/api', api);\nrequire('./health')(app);\nmodule.exports = app;`,
      'src/api.js': `const router = require('express').Router();\nconst users = require('./users');\nrouter.use('/users', users);\nmodule.exports = router;`,
      'src/users.js': `const router = require('express').Router();\nrouter.get('/:id', (req, res) => res.end());\nmodule.exports = router;`,
      'src/health.js': `module.exports = function (app) {\n  app.get('/health', (req, res) => res.end());\n};`,
    });
    expect(steps(find(result.endpoints, 'GET', '/api/users/:id'))).toEqual(['Mounted at "/api" @ src/app.js:4', 'Mounted at "/users" @ src/api.js:3']);
    expect(steps(find(result.endpoints, 'GET', '/health'))).toEqual(['Registered via function call @ src/app.js:5']);
    // Notes keep the same information as text, so endpoint ids are unchanged.
    expect(find(result.endpoints, 'GET', '/api/users/:id').notes.slice(0, 2)).toEqual(['Mounted at "/api" (app.js:4)', 'Mounted at "/users" (api.js:3)']);
  });

  it('records the NestJS global prefix, URI version and controller path', async () => {
    const { result } = await analyzeFiles({
      'src/main.ts': `import { NestFactory } from '@nestjs/core';\nimport { VersioningType } from '@nestjs/common';\nasync function boot() {\n  const app = await NestFactory.create({});\n  app.setGlobalPrefix('api');\n  app.enableVersioning({ type: VersioningType.URI });\n}`,
      'src/cats.controller.ts': `import { Controller, Get, Version } from '@nestjs/common';\n@Controller('cats')\nexport class CatsController {\n  @Version('1') @Get() all() { return []; }\n}`,
    });
    expect(steps(result.endpoints[0])).toEqual(['Global prefix "api" from setGlobalPrefix @ src/main.ts:5', 'URI version "v1" @ src/main.ts:6', "@Controller('cats') on CatsController @ src/cats.controller.ts:2"]);
  });

  it('records the Spring context path and class mapping', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/resources/application.properties': 'server.port=8080\nserver.servlet.context-path=/shop\n',
      'src/main/java/a/Orders.java': `package a;\nimport org.springframework.web.bind.annotation.*;\n@RestController\n@RequestMapping("/orders")\npublic class Orders { @GetMapping public String all() { return ""; } }`,
    });
    expect(steps(result.endpoints[0])).toEqual(['Context path "/shop" @ src/main/resources/application.properties:2', '@RequestMapping("/orders") on Orders @ src/main/java/a/Orders.java:5']);
  });

  it('gives the dashboard clickable steps and drops notes they repeat', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': `const express = require('express');\nconst app = express();\nconst r = express.Router();\nr.get('/x', (req, res) => res.end());\napp.use('/api', r);\nmodule.exports = app;`,
    });
    const table = refTable();
    const model = buildDashboardModel({ result, analyzing: false, impact: { status: 'off' }, dismissed: new Set(), disabledRules: [], graphMaxEndpoints: 10, contracts: { files: [] }, testProjects: [], relativePath: (f) => path.relative(ROOT, f), workspace: 'w' }, table);
    const e = model.endpoints[0] as { trace: { text: string; where: string; ref: number }[]; notes: string[] };
    expect(e.trace).toEqual([{ text: 'Mounted at "/api"', where: 'src/app.js:5', ref: expect.any(Number) }]);
    expect(table.refs[e.trace[0].ref]).toMatchObject({ file: path.join(ROOT, 'src/app.js'), line: 5 });
    expect(e.notes).toEqual([]);
  });
});
