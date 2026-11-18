export function createKanbanDrawerState() {
  return {
    filtersOpen: false,
    layoutOpen: false,
  };
}

export function toggleKanbanDrawer(state, drawer) {
  const next = {
    filtersOpen: false,
    layoutOpen: false,
    ...(state ?? {}),
  };

  if (drawer === 'filters') {
    return {
      filtersOpen: !next.filtersOpen,
      layoutOpen: false,
    };
  }

  if (drawer === 'layout') {
    return {
      filtersOpen: false,
      layoutOpen: !next.layoutOpen,
    };
  }

  return createKanbanDrawerState();
}
