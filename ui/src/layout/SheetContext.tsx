import { createContext, useContext } from 'react';

/**
 * Lets a conversation row close the narrow-screen sheet that contains it.
 *
 * The first version put an onClick on the <nav> wrapper, which the linter correctly refused: a
 * click handler on a non-interactive element is unreachable by keyboard, and a drawer you can only
 * dismiss with a mouse is worse on the screen size where a mouse is least likely.
 *
 * So the row closes it, because the row is the thing that was activated. Outside a sheet this is a
 * no-op and nothing changes.
 */
export const SheetContext = createContext<() => void>(() => {});

export const useCloseSheet = () => useContext(SheetContext);
