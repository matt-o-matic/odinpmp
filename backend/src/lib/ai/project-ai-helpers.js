function countTasks(project) {
  const epics = project.epics ?? [];
  let storyCount = 0;
  let taskCount = 0;
  let atRiskCount = 0;
  let inProgressCount = 0;
  let completedCount = 0;

  for (const epic of epics) {
    if (epic.status === 'At Risk') {
      atRiskCount += 1;
    }

    if (epic.status === 'In Progress') {
      inProgressCount += 1;
    }

    if (epic.status === 'Completed') {
      completedCount += 1;
    }

    for (const story of epic.stories ?? []) {
      storyCount += 1;

      if (story.status === 'At Risk') {
        atRiskCount += 1;
      }

      if (story.status === 'In Progress') {
        inProgressCount += 1;
      }

      if (story.status === 'Completed') {
        completedCount += 1;
      }

      for (const task of story.tasks ?? []) {
        taskCount += 1;

        if (task.status === 'At Risk') {
          atRiskCount += 1;
        }

        if (task.status === 'In Progress') {
          inProgressCount += 1;
        }

        if (task.status === 'Completed') {
          completedCount += 1;
        }
      }
    }
  }

  return {
    atRiskCount,
    completedCount,
    inProgressCount,
    storyCount,
    taskCount,
  };
}

export function summarizeProjectSnapshot(project) {
  const counts = countTasks(project);

  return {
    description: project.description ?? '',
    endDate: project.endDate ?? null,
    epicCount: project.epics?.length ?? 0,
    name: project.name,
    startDate: project.startDate ?? null,
    status: project.status ?? 'Planned',
    ...counts,
  };
}
