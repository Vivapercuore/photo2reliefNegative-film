import { useEffect } from 'react';

/** Site-wide base title. */
export const SITE_TITLE = 'viva的3D打印小工具';

/**
 * Set the document title. Pass a module name to get
 * "模块名 - viva的3D打印小工具"; pass nothing for just the site title.
 * Restores the previous title on unmount.
 */
export function useDocumentTitle(moduleName?: string): void {
  useEffect(() => {
    const prev = document.title;
    document.title = moduleName ? `${moduleName} - ${SITE_TITLE}` : SITE_TITLE;
    return () => {
      document.title = prev;
    };
  }, [moduleName]);
}
