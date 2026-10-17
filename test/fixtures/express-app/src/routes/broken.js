const express = require('express');
const router = express.Router();

router.get('/broken-but-parsed', (req, res) => res.end());

function oops( {
  return 1;
}

module.exports = router;
