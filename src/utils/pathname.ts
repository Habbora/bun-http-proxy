export const formatPathname = (pathname: string): string => {
  return "/" + pathname.split("/").filter(Boolean).join("/");
};
