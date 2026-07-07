import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      // Flag using a name before its definition appears in the file.
      // Function declarations are intentionally allowed (project convention
      // puts small helper components below their parent), but variables,
      // classes, and enums must be declared first — those are the cases
      // that produce real TS2304 / TDZ failures and break mid-edit builds.
      "no-use-before-define": "off",
      "@typescript-eslint/no-use-before-define": [
        "error",
        {
          functions: false,
          classes: true,
          variables: true,
          enums: true,
          typedefs: false,
          ignoreTypeReferences: true,
        },
      ],
      // Enforce British DD/MM/YYYY date formatting across the app.
      //
      // Locale-default `toLocaleDateString()` / `new Date(...).toLocaleString()`
      // render in the *user's browser locale* — a US visitor sees "5/26/2026"
      // instead of "26/05/2026". `new Intl.DateTimeFormat("en-GB", { month:
      // "short" })` also drifts to non-numeric ("26 May 2026") formats.
      //
      // Use the helpers in `@/lib/utils` instead:
      //   - formatDateGB(value)         → "DD/MM/YYYY"
      //   - formatDateTimeGB(value)     → "DD/MM/YYYY, HH:mm"
      //   - formatDateWithWeekdayGB(v)  → "Mon DD/MM/YYYY"
      //   - formatDateLongGB(value)     → "Monday, DD/MM/YYYY"
      //
      // For genuinely non-date uses (extracting just the weekday name, or
      // rendering a month-only chart-axis label) add a targeted
      // `eslint-disable-next-line` with a one-line reason.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='toLocaleDateString']",
          message:
            "Do not use `.toLocaleDateString()` — it renders in the user's locale (US visitors see MM/DD/YYYY). Use formatDateGB / formatDateWithWeekdayGB / formatDateLongGB from @/lib/utils.",
        },
        {
          selector:
            "CallExpression[callee.property.name='toLocaleString'][callee.object.type='NewExpression'][callee.object.callee.name='Date']",
          message:
            "Do not use `new Date(...).toLocaleString()` for date rendering. Use formatDateTimeGB from @/lib/utils so the date always renders as DD/MM/YYYY.",
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.property.name='toLocaleString'][arguments.0.type='Literal']",
          message:
            "Do not call `.toLocaleString(\"...\")` with a locale string for date rendering — use formatDateTimeGB from @/lib/utils. (If this is a number, prefer `.toLocaleString(\"en-GB\")` with an inline eslint-disable-next-line and a reason.)",
        },
        {
          selector:
            "NewExpression[callee.type='MemberExpression'][callee.object.name='Intl'][callee.property.name='DateTimeFormat']",
          message:
            "Do not construct `new Intl.DateTimeFormat(...)` for date rendering — use formatDateGB / formatDateTimeGB from @/lib/utils to keep DD/MM/YYYY consistent.",
        },
      ],
    },
  },
  {
    // shadcn-generated primitives in src/components/ui follow upstream
    // ordering (sub-component used in parent, declared below). They're
    // vendored verbatim — don't lint-flag them.
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-use-before-define": "off",
      // shadcn primitives use `toLocaleDateString` / `toLocaleString`
      // internally for locale-aware calendar dropdowns and `data-day`
      // attributes — not user-visible date fields.
      "no-restricted-syntax": "off",
    },
  },
  {
    // `src/lib/utils.ts` is where the DD/MM/YYYY helpers themselves live —
    // they legitimately call `toLocaleDateString`/`toLocaleString` under
    // the hood to build the canonical format.
    files: ["src/lib/utils.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  eslintPluginPrettier,
);
