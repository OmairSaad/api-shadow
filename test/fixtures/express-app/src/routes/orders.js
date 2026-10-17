const express = require('express');

function listOrders(req, res) {
  res.json([]);
}

function createOrder(req, res) {
  res.status(201).end();
}

function createOrdersRouter() {
  const router = express.Router();
  router.get('/', listOrders);
  router.post('/', createOrder);
  return router;
}

module.exports = createOrdersRouter;
