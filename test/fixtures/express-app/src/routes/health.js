module.exports = function registerHealth(app) {
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/health/ready', (req, res) => res.json({ ready: true }));
};
