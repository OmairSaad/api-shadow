const express = require('express');
const helmet = require('helmet');
const { authenticate, requireAdmin } = require('./middleware/auth');
const usersRouter = require('./routes/users');
const apiRouter = require('./routes');
const registerHealth = require('./routes/health');
const { adminRouter } = require('./routes/admin');
const config = require('./config');

const app = express();

app.use(helmet());
app.use(express.json());

app.use('/api', apiRouter);
app.use('/users', authenticate, usersRouter);
app.use('/admin', authenticate, requireAdmin, adminRouter);
registerHealth(app);

app.get('/', (req, res) => res.send('ok'));
app.get(config.customPath, (req, res) => res.send('custom'));

module.exports = app;
