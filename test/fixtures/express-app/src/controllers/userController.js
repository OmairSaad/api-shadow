const userService = require('../services/userService');

exports.list = async (req, res) => {
  res.json(await userService.findAll());
};

exports.getById = async (req, res) => {
  res.json(await userService.findById(req.params.id));
};

exports.create = async (req, res) => {
  res.status(201).json(await userService.create(req.body));
};

exports.uploadAvatar = (req, res) => res.sendStatus(204);
exports.removeAvatar = (req, res) => res.sendStatus(204);
