import { navigate } from "astro:transitions/client"
import { MERGED_CHANGED_EVENT } from "@/scripts/lib/creds.js"

export function remountOnMergedChange(): () => void {
  const handler = () => {
    navigate(location.pathname + location.search, { history: "replace" }).catch(() => location.reload())
  }
  document.addEventListener(MERGED_CHANGED_EVENT, handler)
  return () => document.removeEventListener(MERGED_CHANGED_EVENT, handler)
}
