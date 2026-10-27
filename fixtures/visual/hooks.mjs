// The fixture's app hooks: the hosted scene is only ready once the host-side script released it.
export async function settle({ page, scene, host }) {
  if (scene.name !== "hosted") return;
  await host("release");
  await page.waitForSelector("#state.released");
}
