import { runIntegrityRepair } from "../server/lib/data-maintenance";

async function main() {
  const report = await runIntegrityRepair();
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
