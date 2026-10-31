/** True when the app runs against in-browser fixtures (`npm run dev:fixtures` or VITE_USE_FIXTURES=1). */
export const FIXTURES = import.meta.env.VITE_USE_FIXTURES === "1" || import.meta.env.MODE === "fixtures";
