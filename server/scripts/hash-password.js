// Uso: node scripts/hash-password.js "minha-senha-forte"
const bcrypt = require('bcryptjs');
const senha = process.argv[2];
if (!senha) {
  console.error('Uso: node scripts/hash-password.js "sua-senha"');
  process.exit(1);
}
console.log(bcrypt.hashSync(senha, 10));
