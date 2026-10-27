// The contract's profiles: what each workflow renders and how the files are named.
// CONTRACT.md documents the same numbers; keep them in sync.

const DESKTOP_LANDING = { width: 1600, height: 1000, scale: 2 };
const PHONE_LANDING = { width: 390, height: 844, scale: 3, mobile: true };

export const PROFILES = {
  // personal-landing: dark only, one fixed spec for every app.
  landing: {
    tag: "presentation",
    schemes: ["dark"],
    viewports: { desktop: DESKTOP_LANDING, mobile: PHONE_LANDING },
    fullPage: false,
    loops: true,
    file: (scene, vp) => `${scene}-${vp}.png`,
  },
  // README: light and dark so the repo page matches the reader's theme.
  readme: {
    tag: "presentation",
    schemes: ["light", "dark"],
    viewports: {
      desktop: { width: 1440, height: 900, scale: 2 },
      mobile: { width: 390, height: 844, scale: 2, mobile: true },
    },
    fullPage: false,
    loops: true,
    file: (scene, vp, scheme) => `${scene}-${scheme}-${vp}.png`,
  },
  // Per-change visual check: fast, comparable, throwaway.
  check: {
    tag: "check",
    schemes: ["dark", "light"],
    viewports: {
      desktop: { width: 1440, height: 900, scale: 1 },
      phone: { width: 390, height: 844, scale: 1, mobile: true },
    },
    fullPage: true,
    loops: false,
    file: (scene, vp, scheme) => `${scene}.${vp}.${scheme}.png`,
  },
  // Periodic audit: every route, every form factor.
  audit: {
    tag: "audit",
    schemes: ["dark", "light"],
    viewports: {
      desktop: { width: 1440, height: 900, scale: 1 },
      tablet: { width: 820, height: 1180, scale: 1 },
      phone: { width: 390, height: 844, scale: 2, mobile: true },
    },
    fullPage: true,
    loops: false,
    file: (scene, vp, scheme) => `${scene}.${vp}.${scheme}.png`,
  },
};

export const DEFAULT_TAGS = ["check", "audit"];

/** The profile's viewports, plus the repo's overrides. The landing spec is fixed for every app: no overrides. */
export function viewportsFor(cfg, profileName) {
  const profile = PROFILES[profileName];
  return profileName === "landing" ? profile.viewports : { ...profile.viewports, ...(cfg.viewports ?? {}) };
}

export const viewportFor = (cfg, profileName, name) => viewportsFor(cfg, profileName)[name];

/** The scenes a profile renders, narrowed by `--routes`: a scene name, or a path that matches itself and everything below it. */
export function selectScenes(cfg, profileName, routes = []) {
  const profile = PROFILES[profileName];
  const inProfile = cfg.scenes.filter((s) => (s.tags ?? DEFAULT_TAGS).includes(profile.tag));
  if (!routes.length) return inProfile;
  const wanted = (s) =>
    routes.some((raw) => {
      if (s.name === raw) return true;
      const r = raw.replace(/\/+$/, "") || "/";
      const pathOnly = s.path.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
      return pathOnly === r || pathOnly.startsWith(`${r}/`);
    });
  return inProfile.filter(wanted);
}

/** One entry per scene × viewport × scheme the profile renders for the scene (none for a loop-only scene). */
export function variants(cfg, profileName, scene) {
  if (scene.stills === false) return [];
  const profile = PROFILES[profileName];
  const viewports = viewportsFor(cfg, profileName);
  const names = (scene.viewports ?? Object.keys(profile.viewports)).filter((n) => viewports[n]);
  const schemes = (scene.schemes ?? profile.schemes).filter((s) => profile.schemes.includes(s));
  const out = [];
  for (const vp of names) {
    for (const scheme of schemes) {
      out.push({ vp, scheme, viewport: viewports[vp], file: profile.file(scene.name, vp, scheme) });
    }
  }
  return out;
}
