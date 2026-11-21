import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores([
    "node_modules",
    "dist",
    "main.js",
    "esbuild.config.mjs",
    "scripts/**",
    "tests/**"
  ]),
  ...obsidianmd.configs.recommendedWithLocalesEn,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.*"]
        }
      }
    },
    rules: {
      "obsidianmd/sample-names": "off",
      "obsidianmd/ui/sentence-case-locale-module": [
        "warn",
        {
          brands: [
            "Obsidian",
            "GitHub",
            "Baidu",
            "Baidu Netdisk",
            "Baidu Netdisk Open Platform",
            "AppKey",
            "AppSecret",
            "OAuth"
          ],
          ignoreRegex: ["/apps/obsidian_vault"],
          acronyms: [
            "ID",
            "URL",
            "HTTP",
            "JSON",
            "CSS",
            "E2EE",
            "AES",
            "GCM",
            "PIN",
            "QPS",
            "MB",
            "LWW",
            "MD5",
            "API"
          ]
        }
      ]
    }
  }
]);
