import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { analyzeTsConfig, stripJsonComments } from '../../src/analyzers/tsconfig';
import { resolveWithAliases } from '../../src/linkers/context';
import { analyzeFiles, ROOT } from '../helpers/memoryHost';

const abs = (rel: string): string => path.join(ROOT, rel);

describe('Module path aliases', () => {
  it('reads tsconfig files with comments and trailing commas', () => {
    expect(stripJsonComments('{ "a": "http://x", // c\n /* b */ "b": [1,], }')).toBe('{ "a": "http://x", \n  "b": [1] }');
    expect(analyzeTsConfig('{ // app\n "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/*"], }, }, }')).toEqual({ lang: 'tsconfig', baseUrl: '.', paths: { '@app/*': ['src/app/*'] }, issues: [] });
    expect(analyzeTsConfig('not json').issues).toHaveLength(1);
  });

  it('resolves paths, baseUrl and the @/ convention, and leaves packages alone', () => {
    const files = new Set([abs('web/src/services/user.ts'), abs('web/src/lib/index.ts'), abs('other/src/api.js')]);
    const aliases = [{ dir: abs('web'), baseUrl: abs('web/src'), paths: [{ pattern: '~services/*', targets: ['services/*'] }] }];
    const from = abs('web/src/pages/Profile.tsx');
    expect(resolveWithAliases(from, '~services/user', files, aliases)).toBe(abs('web/src/services/user.ts'));
    expect(resolveWithAliases(from, 'lib', files, aliases)).toBe(abs('web/src/lib/index.ts'));
    expect(resolveWithAliases(abs('other/src/pages/x.js'), '@/api', files, aliases)).toBe(abs('other/src/api.js'));
    expect(resolveWithAliases(from, 'react', files, aliases)).toBeUndefined();
    expect(resolveWithAliases(from, '../services/user', files, aliases)).toBe(abs('web/src/services/user.ts'));
  });

  it('follows response reads into service modules imported through aliases', async () => {
    const { result } = await analyzeFiles({
      'server/package.json': '{}',
      'server/app.js': `const app = require('express')();\napp.get('/api/users/:id', (req, res) => res.json({ id: 1, fullName: 'x' }));\nmodule.exports = app;`,
      'web/package.json': '{}',
      'web/tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
      'web/src/services/users.ts': `import axios from 'axios';\nexport async function getUser(id: string) { const { data } = await axios.get(\`/api/users/\${id}\`); return data; }`,
      'web/src/pages/Profile.tsx': `import { getUser } from '@/services/users';\nexport async function Profile() { const u = await getUser('1'); return <h1>{u.name}</h1>; }`,
    });
    const call = result.clientCalls[0];
    expect(call.consumers?.map((c) => c.within)).toEqual(['Profile']);
    expect(result.issues.filter((i) => i.kind === 'response-mismatch').map((i) => i.location?.file)).toEqual([abs('web/src/pages/Profile.tsx')]);
  });
});
