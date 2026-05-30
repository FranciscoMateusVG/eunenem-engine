/** @type {import('lint-staged').Configuration} */
export default {
  '*.{ts,tsx,js,json}': (files) => {
    // biome.json's files.includes excludes the apps/ tree ("!apps").
    // Mirror that filter here so lint-staged does not hand biome paths
    // it will reject as "ignored" — biome surfaces that as a failure,
    // which lint-staged + husky escalate into a blocked commit for any
    // file under apps/*. (aperture-wupjr — unblocks all apps/ commits.)
    const lintable = files.filter(
      (file) => !file.includes('.generated.') && !file.includes('/apps/'),
    );
    if (lintable.length === 0) {
      return [];
    }
    return [`biome check --write ${lintable.join(' ')}`];
  },
};
