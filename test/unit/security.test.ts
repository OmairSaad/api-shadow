import { describe, expect, it } from 'vitest';
import { scanText } from '../../src/core/textScan';
import type { SecurityFinding } from '../../src/core/security';
import { analyzeFiles } from '../helpers/memoryHost';

const rules = (findings: SecurityFinding[]): string[] => findings.map((f) => `${f.rule}:${f.severity}/${f.confidence}`).sort();
const express = (body: string, head = ''): string => `const express = require('express'); const app = express(); const User = require('./models/User');\n${head}\n${body}\nmodule.exports = app;`;

describe('Security Radar: hardcoded credentials', () => {
  // Fake values assembled at runtime so the repository never contains a key-shaped literal.
  const stripe = ['sk', 'live', 'abcdefghijklmnopqrstuvwx12'].join('_');
  const aws = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');

  it('finds provider keys, credential assignments and JWT secrets', () => {
    const risks = scanText(`const STRIPE = '${stripe}';\nconst awsKey = "${aws}";\nconst apiKey = "a8f5f167f44f4964e6c998dee827110c";\njwt.sign(payload, 'my-dev-secret');\nconst url = 'mongodb://admin:hunter22@db:27017/app';`, 'js');
    expect(risks.map((r) => r.pos.line)).toEqual([1, 2, 3, 4, 5]);
    expect(risks.map((r) => r.detail)).toEqual(['high', 'high', 'medium', 'high', 'medium']);
  });

  it('never stores any part of the secret value', () => {
    const risks = scanText(`const STRIPE = '${stripe}';\nspring.datasource.password=s3cr3tPassw0rd`, 'js').concat(scanText('spring.datasource.password=s3cr3tPassw0rd', 'config'));
    const blob = JSON.stringify(risks);
    expect(blob).not.toContain('abcdefghijklmnop');
    expect(blob).not.toContain('s3cr3t');
    expect(blob).not.toContain('s3');
    expect(risks[0].evidence).toBe('Stripe live key "sk_live_…" (34 chars)');
  });

  it('ignores placeholders, environment lookups, labels and storage keys', () => {
    const risks = scanText(
      [
        `const apiKey = process.env.API_KEY;`,
        `const password = 'changeme';`,
        `const TOKEN_KEY = 'auth_token';`,
        `const passwordLabel = 'Enter your password';`,
        `headers: { 'X-Api-Key': 'X-Api-Key' }`,
        `const secret = \`\${process.env.SECRET}\`;`,
        `const token = 'ACCESS_TOKEN';`,
      ].join('\n'),
      'js',
    );
    expect(risks).toEqual([]);
    expect(scanText('jwt.secret=${JWT_SECRET}\nspring.datasource.password=\napp.secret=<your-secret>', 'config')).toEqual([]);
  });

  it('lowers the severity of credentials in test files', async () => {
    const { result } = await analyzeFiles({ 'src/app.js': express(''), 'test/app.test.js': `const apiKey = "a8f5f167f44f4964e6c998dee827110c";` });
    expect(rules(result.security.filter((f) => f.rule === 'hardcoded-secret'))).toEqual(['hardcoded-secret:low/low']);
  });

  it('scans files that declare no routes', async () => {
    const { result } = await analyzeFiles({ 'src/app.js': express(''), 'src/config.js': `module.exports = { stripe: '${stripe}' };` });
    expect(result.security.map((f) => f.location.file.split('/').pop())).toContain('config.js');
  });
});

describe('Security Radar: request handling', () => {
  it('reports permissive CORS by how open it is', async () => {
    const { result } = await analyzeFiles({
      'a/app.js': `const cors = require('cors'); const app = require('express')();\napp.use(cors());\nmodule.exports = app;`,
      'b/app.js': `const app = require('express')();\napp.use(require('cors')({ origin: true, credentials: true }));\nmodule.exports = app;`,
      'c/main.ts': `import { NestFactory } from '@nestjs/core';\nasync function boot() { const app = await NestFactory.create({}); app.enableCors({ origin: '*' }); }`,
      'd/src/main/java/a/Api.java': `package a;\nimport org.springframework.web.bind.annotation.*;\n@RestController @CrossOrigin\npublic class Api { @GetMapping("/x") public String x() { return ""; } }`,
      'pom.xml': '<project/>',
    });
    expect(rules(result.security.filter((f) => f.rule === 'permissive-cors'))).toEqual(['permissive-cors:high/high', 'permissive-cors:low/high', 'permissive-cors:low/high', 'permissive-cors:low/high']);
    expect(result.security.find((f) => f.severity === 'high')?.evidence).toBe('cors({ origin: true, credentials: true })');
  });

  it('reports mass assignment, lowered when the body is validated', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': express(`app.post('/users', async (req, res) => res.json(await User.create(req.body)));\napp.put('/users/:id', validate(schema), async (req, res) => res.json(await User.findByIdAndUpdate(req.user.id, { ...req.body })));\napp.post('/notes', async (req, res) => { const { title } = req.body; res.json(await Note.create({ title })); });`, `const validate = require('./middleware/validate');`),
    });
    const mass = result.security.filter((f) => f.rule === 'mass-assignment');
    expect(mass.map((f) => `${f.endpoint} ${f.severity}`).sort()).toEqual(['POST /users medium', 'PUT /users/:id low']);
  });

  it('finds injection, open redirects, file paths from input and error details', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': express(
        [
          `app.get('/search', async (req, res) => res.json(await db.query(\`SELECT * FROM t WHERE name = '\${req.query.q}'\`)));`,
          `app.get('/safe', async (req, res) => res.json(await db.query('SELECT * FROM t WHERE id = $1', [req.query.id])));`,
          `app.get('/go', (req, res) => res.redirect(req.query.next));`,
          `app.get('/files/:name', (req, res) => res.sendFile(path.join(__dirname, 'uploads', req.params.name)));`,
          `app.get('/files2/:name', (req, res) => res.sendFile(path.join(__dirname, 'uploads', path.basename(req.params.name))));`,
          `app.get('/boom', async (req, res) => { try { await work(); res.end(); } catch (err) { res.status(500).json({ message: err.message, stack: err.stack }); } });`,
          `app.post('/run', (req, res) => { exec('convert ' + req.body.file); res.end(); });`,
        ].join('\n'),
      ),
    });
    const byEndpoint = result.security.filter((f) => f.rule !== 'missing-auth').map((f) => `${f.endpoint} ${f.rule} ${f.severity}`).sort();
    expect(byEndpoint).toEqual(['GET /boom error-details medium', 'GET /files/:name path-traversal high', 'GET /go open-redirect medium', 'GET /search injection high', 'POST /run injection high']);
  });

  it('uses inherited router middleware for auth, and flags admin routes without it', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': express(
        `const admin = express.Router();\nadmin.use(requireAuth);\nadmin.delete('/users/:id', (req, res) => res.end());\napp.use('/admin', admin);\napp.delete('/api/admin/cache', (req, res) => res.end());\napp.get('/me', requireAuth, (req, res) => res.json(req.user));`,
        `const { requireAuth } = require('./auth');`,
      ),
    });
    const missing = result.security.filter((f) => f.rule === 'missing-auth');
    expect(missing.map((f) => `${f.endpoint} ${f.severity}`)).toEqual(['DELETE /api/admin/cache high']);
  });

  it('flags sensitive response fields, except tokens returned by sign-in endpoints', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': express(
        `app.get('/users/:id', requireAuth, async (req, res) => { const u = await User.findById(req.user.id); res.json({ id: u.id, email: u.email, passwordHash: u.passwordHash }); });\napp.post('/auth/login', (req, res) => res.json({ accessToken: sign(req.body) }));\napp.get('/me', requireAuth, async (req, res) => { const user = await User.findById(req.user.id); res.json(user); });`,
        `const { requireAuth } = require('./auth');`,
      ),
    });
    const sensitive = result.security.filter((f) => f.rule === 'sensitive-response');
    expect(sensitive.map((f) => `${f.endpoint} ${f.severity}/${f.confidence}`).sort()).toEqual(['GET /me medium/low', 'GET /users/:id high/medium']);
  });

  it('flags ids used without an ownership check on protected routes only', async () => {
    const { result } = await analyzeFiles({
      'src/app.js': express(
        [
          `app.delete('/orders/:orderId', requireAuth, async (req, res) => { await Order.deleteOne({ _id: req.params.orderId }); res.sendStatus(204); });`,
          `app.put('/posts/:id', requireAuth, async (req, res) => { await Post.updateOne({ _id: req.params.id, owner: req.user.id }, { title: req.body.title }); res.end(); });`,
          `app.get('/docs/:id', requireAuth, checkPermission('read'), async (req, res) => res.json(await Doc.findById(req.params.id)));`,
        ].join('\n'),
        `const { requireAuth, checkPermission } = require('./auth');`,
      ),
    });
    expect(result.security.filter((f) => f.rule === 'object-authorization').map((f) => `${f.endpoint} ${f.severity}/${f.confidence}`)).toEqual(['DELETE /orders/:orderId medium/low']);
  });

  it('reads Spring risks: SQL concatenation, entity request bodies, exception messages and configuration', async () => {
    const { result } = await analyzeFiles({
      'pom.xml': '<project/>',
      'src/main/resources/application.properties': 'server.error.include-stacktrace=always\nmanagement.endpoints.web.exposure.include=*\n',
      'src/main/java/a/User.java': `package a;\nimport jakarta.persistence.*;\n@Entity public class User { @Id private Long id; private String role; }`,
      'src/main/java/a/UserController.java': `package a;
import org.springframework.web.bind.annotation.*;
@RestController @RequestMapping("/users")
public class UserController {
  private JdbcTemplate jdbc;
  @GetMapping("/search") public Object search(@RequestParam String name) { return jdbc.queryForList("SELECT * FROM users WHERE name = '" + name + "'"); }
  @PostMapping public User create(@RequestBody User user) { try { return repo.save(user); } catch (Exception e) { return e.getMessage(); } }
}`,
    });
    expect(rules(result.security.filter((f) => f.rule !== 'missing-auth'))).toEqual(['config-exposure:medium/high', 'error-details:low/medium', 'error-details:medium/high', 'injection:high/medium', 'mass-assignment:medium/medium']);
  });

  it('honours disabled rules and excluded files, and keeps ids stable when lines move', async () => {
    const files = { 'src/app.js': express(`app.post('/users', async (req, res) => res.json(await User.create(req.body)));`) };
    const { result } = await analyzeFiles(files, { security: { enabled: true, disabledRules: ['mass-assignment'] } });
    expect(result.security.filter((f) => f.rule === 'mass-assignment')).toEqual([]);
    const excluded = await analyzeFiles(files, { security: { enabled: true, disabledRules: [], isExcluded: (f) => f.endsWith('app.js') } });
    expect(excluded.result.security).toEqual([]);
    const a = (await analyzeFiles(files)).result.security.find((f) => f.rule === 'mass-assignment')!;
    const b = (await analyzeFiles({ 'src/app.js': '\n\n' + files['src/app.js'] })).result.security.find((f) => f.rule === 'mass-assignment')!;
    expect(a.location.line).not.toBe(b.location.line);
    expect(a.id).toBe(b.id);
  });
});
