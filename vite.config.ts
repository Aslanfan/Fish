import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";

// `npm run phone` (mode "phone") serves over https with a self-signed certificate, for phone browsers that
// refuse plain http. Plain `npm run dev` stays on http.
export default defineConfig(({ mode }) => ({
  root: "web",
  plugins: mode === "phone" ? [basicSsl()] : [],
}));
