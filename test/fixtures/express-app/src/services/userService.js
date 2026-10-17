async function findAll() {
  return [];
}

async function findById(id) {
  return { id };
}

async function create(user) {
  return user;
}

module.exports = { findAll, findById, create };
