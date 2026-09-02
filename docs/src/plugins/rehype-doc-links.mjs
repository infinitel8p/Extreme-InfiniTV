// Rewrites relative doc links to base-absolute URLs; GH Pages directory URLs need trailing slashes.

const EXTERNAL = /^(https?:|mailto:|tel:|#|\/\/)/

export function rehypeDocLinks({ base = "" } = {}) {
  const prefix = base.replace(/\/$/, "")

  return (tree) => {
    walk(tree)
  }

  function walk(node) {
    if (node.type === "element" && node.tagName === "a") {
      const href = node.properties?.href
      const alreadyPrefixed = href === prefix || href === prefix + "/" || (typeof href === "string" && href.startsWith(prefix + "/"))
      if (typeof href === "string" && !EXTERNAL.test(href) && !alreadyPrefixed) {
        if (!href.startsWith("/")) {
          const slug = href.replace(/^(?:\.\.?\/)+/, "")
          node.properties.href = `${prefix}/${slug}`
        } else {
          node.properties.href = `${prefix}${href}`
        }
      }
    }
    for (const child of node.children || []) walk(child)
  }
}
