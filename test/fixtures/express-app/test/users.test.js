const request = require('supertest');
const app = require('../src/app');

describe('users', () => {
  it('lists users', () => request(app).get('/users').expect(200));
  it('gets a user', () => request(app).get('/users/42').expect(200));
});
