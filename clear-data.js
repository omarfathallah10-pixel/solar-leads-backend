require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

(async () => {
  // Order matters: children before parents, or the foreign keys block it.
  console.log("leads          ", (await p.lead.deleteMany({})).count);
  console.log("leadScores     ", (await p.leadScore.deleteMany({})).count);
  console.log("contacts       ", (await p.contact.deleteMany({})).count);
  console.log("sites          ", (await p.companySite.deleteMany({})).count);
  console.log("companies      ", (await p.company.deleteMany({})).count);
  console.log("sourceRecords  ", (await p.rawSourceRecord.deleteMany({})).count);
  await p.$disconnect();
})();
