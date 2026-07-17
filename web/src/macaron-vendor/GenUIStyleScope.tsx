import { createStyleScope } from "@genui/unocss";
import { unoRules, unoShortcuts, unoTheme } from "@/lib/uno-shared";

export { useStyleScope as useGenUIStyleScope } from "@genui/unocss";
export default createStyleScope({ scopeClass: "genui-root", theme: unoTheme, shortcuts: unoShortcuts, rules: unoRules });
