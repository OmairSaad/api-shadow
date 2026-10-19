import * as request from 'supertest';

describe('UsersController (e2e)', () => {
  let app: { getHttpServer(): unknown };
  it('/v1/users (GET)', () => request(app.getHttpServer()).get('/api/v1/users').expect(200));
});
