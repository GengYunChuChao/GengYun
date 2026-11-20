import * as React from "react";

const NAVIGATE_EVENT = "gy:navigate";

export function normalizePath(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

function readPath(): string {
  const hash = window.location.hash;
  if (hash.startsWith("#/")) {
    return normalizePath(hash.slice(1));
  }
  return normalizePath(window.location.pathname);
}

export function navigate(to: string) {
  const next = normalizePath(to);
  if (readPath() !== next) {
    window.history.pushState({}, "", `#${next}`);
  }
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = React.useState(readPath);
  React.useEffect(() => {
    const update = () => setPath(readPath());
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    window.addEventListener(NAVIGATE_EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
      window.removeEventListener(NAVIGATE_EVENT, update);
    };
  }, []);
  return path;
}

type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

export function Link({ to, onClick, ...props }: LinkProps) {
  const href = `#${normalizePath(to)}`;
  return (
    <a
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        navigate(to);
      }}
      {...props}
    />
  );
}
