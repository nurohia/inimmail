require("dotenv").config();

const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL,
  }),
});

async function main() {
  await prisma.redeemCode.upsert({
    where: {
      code: "TEST-888",
    },
    update: {
      durationHours: 1,
    },
    create: {
      code: "TEST-888",
      durationHours: 1,
    },
  });

  console.log("Seeded redeem code TEST-888 (1 hour).");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
