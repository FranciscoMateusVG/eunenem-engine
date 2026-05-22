/** @type {import('lint-staged').Configuration} */
export default {
  '*.{ts,tsx,js,json}': (files) => {
    const lintable = files.filter((file) => !file.includes('.generated.'));
    if (lintable.length === 0) {
      return [];
    }
    return [`biome check --write ${lintable.join(' ')}`];
  },
};
