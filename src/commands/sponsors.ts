import { updateIndRegister } from '../sponsors.ts';

/** sponsors:update: downloads the Dutch IND recognised-sponsor register. */
export async function sponsorsUpdate() {
  console.log(`IND register saved: ${await updateIndRegister()} recognised sponsors`);
}
