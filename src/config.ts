// Place any global data in this file.
// You can import this data from anywhere in your site by using the `import` keyword.

export const SITE_TITLE = "telfyc";
export const AUTHOR_NAME = "telfyc";
export const AUTHOR_INITIAL = "T";
export const SITE_DESCRIPTION = "telfyc's personal website.";
export const GENERATE_SLUG_FROM_TITLE = true;
export const TRANSITION_API = true;

// Base path helper for GitHub Pages project sites
// In dev: "/" — in prod with BASE_URL: "/ac-site-template/"
const BASE_PATH = import.meta.env.BASE_URL;
export const url = (path: string) => {
  const clean = path.replace(/^\//, "");
  return clean ? BASE_PATH + clean : BASE_PATH;
};
export { BASE_PATH };
