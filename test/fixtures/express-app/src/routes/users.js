const express = require('express');
const userController = require('../controllers/userController');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.get('/', userController.list);
router.get('/:id', userController.getById);
// Never runs: GET /:id above matches /me first.
router.get('/me', userController.me);
router.post('/', validate('user'), userController.create);
router
  .route('/:id/avatar')
  .put(userController.uploadAvatar)
  .delete(userController.removeAvatar);

// Accidental duplicate of GET /:id
router.get('/:userId', userController.getById);

module.exports = router;
