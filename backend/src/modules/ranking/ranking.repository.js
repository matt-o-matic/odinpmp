import { randomUUID } from 'node:crypto';

import { sanitizeRichHtml } from '../../lib/content/html-content.js';
import { activeProjectSql } from '../projects/project-deletion.repository.js';
import { deliveryProjectSql, isEngagementProject } from '../../lib/projects/project-kind.js';

// Ranking covers live delivery projects; engagements stay out until they convert.
function rankedProjectSql(alias) {
  return `${activeProjectSql(alias)} AND ${deliveryProjectSql(alias)}`;
}

function normalizeId(value) {
  return String(value ?? '').trim();
}

function orderedPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function pairKey(a, b) {
  const [left, right] = orderedPair(a, b);
  return `${left}-${right}`;
}

function computeRankOrder(projectIds, votes) {
  const wins = Object.fromEntries(projectIds.map((id) => [id, 0]));
  const pairs = {};

  for (const vote of votes) {
    if (!vote.winnerId) {
      continue;
    }

    if (wins[vote.winnerId] == null) {
      wins[vote.winnerId] = 0;
    }

    wins[vote.winnerId] += 1;
    pairs[`${vote.projectAId}-${vote.projectBId}`] = vote.winnerId;
    pairs[`${vote.projectBId}-${vote.projectAId}`] = vote.winnerId;
  }

  return [...projectIds].sort((a, b) => {
    if ((wins[a] ?? 0) === (wins[b] ?? 0)) {
      const key = `${a}-${b}`;
      if (pairs[key]) {
        return pairs[key] === a ? -1 : 1;
      }
      return 0;
    }

    return (wins[a] ?? 0) > (wins[b] ?? 0) ? -1 : 1;
  });
}

function summarizeLeaderboard(projects, votes) {
  const winCounts = {};
  const comparisonCounts = {};

  for (const project of projects) {
    winCounts[project.id] = 0;
    comparisonCounts[project.id] = 0;
  }

  for (const vote of votes) {
    if (!vote.winnerId) {
      continue;
    }

    comparisonCounts[vote.projectAId] = (comparisonCounts[vote.projectAId] ?? 0) + 1;
    comparisonCounts[vote.projectBId] = (comparisonCounts[vote.projectBId] ?? 0) + 1;
    winCounts[vote.winnerId] = (winCounts[vote.winnerId] ?? 0) + 1;
  }

  return projects
    .map((project) => {
      const comparisons = comparisonCounts[project.id] ?? 0;
      const wins = winCounts[project.id] ?? 0;

      return {
        id: project.id,
        name: project.name,
        rank: project.rank ?? null,
        status: project.status ?? '',
        totalComparisons: comparisons,
        winPercentage: comparisons > 0 ? Math.round(((wins / comparisons) * 100) * 10) / 10 : 0,
        wins,
      };
    })
    .sort((left, right) => {
      if (left.rank == null && right.rank != null) return 1;
      if (left.rank != null && right.rank == null) return -1;
      if (left.rank != null && right.rank != null && left.rank !== right.rank) return left.rank - right.rank;
      return left.name.localeCompare(right.name);
    });
}

export function createInMemoryRankingRepository({
  authRepository,
  projectRepository,
} = {}) {
  const state = {
    votes: [],
  };

  function listProjectsForTenant(tenantId) {
    const projects = projectRepository?.state?.projects ?? [];
    return projects.filter((project) => project.tenantId === tenantId && !isEngagementProject(project));
  }

  function recordRanks(tenantId) {
    const projects = listProjectsForTenant(tenantId);
    const ids = projects.map((project) => project.id);
    const votes = state.votes.filter((vote) => vote.tenantId === tenantId);
    const sorted = computeRankOrder(ids, votes);

    sorted.forEach((projectId, index) => {
      const project = projects.find((item) => item.id === projectId);
      if (project) {
        project.rank = index + 1;
      }
    });
  }

  function hasUserVotedOnPair({ tenantId, userId, projectAId, projectBId }) {
    const key = pairKey(projectAId, projectBId);
    return state.votes.some(
      (vote) => vote.tenantId === tenantId && vote.userId === userId && pairKey(vote.projectAId, vote.projectBId) === key,
    );
  }

  function projectSummary(project) {
    return {
      createdAt: project.createdAt ?? null,
      description: project.description ?? '',
      endDate: project.endDate ?? null,
      id: project.id,
      name: project.name,
      rank: project.rank ?? null,
      startDate: project.startDate ?? null,
      status: project.status ?? '',
      updatedAt: project.updatedAt ?? null,
    };
  }

  function userProjectRole(projectId, userId) {
    const user = authRepository?.state?.users?.find((item) => item.id === userId);
    const membership = user?.memberships?.[0];
    return membership?.role ?? 'user';
  }

  return {
    state,
    async getNextRankPair({ tenantId, userId }) {
      const projects = listProjectsForTenant(tenantId);
      const ids = projects.map((project) => project.id);

      for (let attempts = 0; attempts < 200; attempts += 1) {
        const aIndex = Math.floor(Math.random() * ids.length);
        let bIndex = Math.floor(Math.random() * ids.length);

        if (ids.length < 2) {
          return null;
        }

        while (bIndex === aIndex) {
          bIndex = Math.floor(Math.random() * ids.length);
        }

        const projectAId = ids[aIndex];
        const projectBId = ids[bIndex];

        if (hasUserVotedOnPair({ tenantId, userId, projectAId, projectBId })) {
          continue;
        }

        const projectA = projects.find((project) => project.id === projectAId);
        const projectB = projects.find((project) => project.id === projectBId);

        if (!projectA || !projectB) {
          continue;
        }

        return {
          projectA: {
            ...projectSummary(projectA),
            taskStats: {
              totalEstimatedHours: 0,
              totalPoints: 0,
              totalTasks: 0,
              topLevelTasks: (projectA.epics ?? []).length,
            },
            userRole: userProjectRole(projectA.id, userId),
          },
          projectB: {
            ...projectSummary(projectB),
            taskStats: {
              totalEstimatedHours: 0,
              totalPoints: 0,
              totalTasks: 0,
              topLevelTasks: (projectB.epics ?? []).length,
            },
            userRole: userProjectRole(projectB.id, userId),
          },
        };
      }

      return null;
    },
    async submitVote({ loserId, tenantId, userId, winnerId }) {
      const winner = normalizeId(winnerId);
      const loser = normalizeId(loserId);
      const [projectAId, projectBId] = orderedPair(winner, loser);

      state.votes.push({
        createdAt: new Date().toISOString(),
        id: randomUUID(),
        loserId: loser,
        projectAId,
        projectBId,
        tenantId,
        userId,
        winnerId: winner,
      });

      recordRanks(tenantId);
      return true;
    },
    async skipPair({ projectAId, projectBId, tenantId, userId }) {
      const [a, b] = orderedPair(projectAId, projectBId);

      state.votes.push({
        createdAt: new Date().toISOString(),
        id: randomUUID(),
        projectAId: a,
        projectBId: b,
        tenantId,
        userId,
        winnerId: null,
      });

      return true;
    },
    async getCompletionStatus({ tenantId, threshold = 70, userId }) {
      const projectCount = listProjectsForTenant(tenantId).length;
      const totalPairs = (projectCount * (projectCount - 1)) / 2;
      const userVotes = state.votes.filter((vote) => vote.tenantId === tenantId && vote.userId === userId).length;
      const completionPercentage = totalPairs > 0 ? (userVotes / totalPairs) * 100 : 100;

      return {
        completionPercentage: Math.round(completionPercentage * 10) / 10,
        isComplete: completionPercentage >= threshold,
        threshold,
        totalPairs,
        userVotes,
      };
    },
    async getLeaderboard({ tenantId }) {
      const projects = listProjectsForTenant(tenantId).map(projectSummary);
      const votes = state.votes.filter((vote) => vote.tenantId === tenantId);

      return summarizeLeaderboard(projects, votes);
    },
    async getUserVoteHistory({ tenantId, userId }) {
      const votes = state.votes
        .filter((vote) => vote.tenantId === tenantId && vote.userId === userId)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 50);

      const projects = new Map(listProjectsForTenant(tenantId).map((project) => [project.id, project]));
      const history = votes.map((vote) => {
        const projectA = projects.get(vote.projectAId);
        const projectB = projects.get(vote.projectBId);
        const winner = vote.winnerId ? projects.get(vote.winnerId) : null;

        return {
          createdAt: vote.createdAt,
          projectAName: projectA?.name ?? vote.projectAId,
          projectBName: projectB?.name ?? vote.projectBId,
          winnerId: vote.winnerId,
          winnerName: winner?.name ?? null,
        };
      });

      const totalVotes = state.votes.filter((vote) => vote.tenantId === tenantId && vote.userId === userId).length;
      const actualVotes = state.votes.filter((vote) => vote.tenantId === tenantId && vote.userId === userId && vote.winnerId).length;

      return {
        history,
        stats: {
          actualVotes,
          skips: totalVotes - actualVotes,
          totalVotes,
        },
      };
    },
    async getProjectHeadToHead({ projectId, tenantId }) {
      const projects = new Map(listProjectsForTenant(tenantId).map((project) => [project.id, project]));
      const project = projects.get(projectId);

      if (!project) {
        return null;
      }

      const opponents = {};
      let totalWins = 0;
      let totalVotes = 0;

      for (const vote of state.votes) {
        if (vote.tenantId !== tenantId || !vote.winnerId) {
          continue;
        }

        if (vote.projectAId !== projectId && vote.projectBId !== projectId) {
          continue;
        }

        const opponentId = vote.projectAId === projectId ? vote.projectBId : vote.projectAId;
        const opponentProject = projects.get(opponentId);
        const won = vote.winnerId === projectId;

        if (!opponents[opponentId]) {
          opponents[opponentId] = {
            id: opponentId,
            losses: 0,
            name: opponentProject?.name ?? opponentId,
            totalVotes: 0,
            votes: [],
            winPercentage: 0,
            wins: 0,
          };
        }

        opponents[opponentId].votes.push({
          createdAt: vote.createdAt,
          voterName: 'Unknown',
          won,
        });

        if (won) {
          opponents[opponentId].wins += 1;
          totalWins += 1;
        } else {
          opponents[opponentId].losses += 1;
        }

        opponents[opponentId].totalVotes += 1;
        totalVotes += 1;
      }

      const opponentValues = Object.values(opponents).map((opponent) => {
        const winPercentage = opponent.totalVotes > 0 ? Math.round(((opponent.wins / opponent.totalVotes) * 100) * 10) / 10 : 0;
        return {
          ...opponent,
          winPercentage,
        };
      });

      opponentValues.sort((a, b) => b.winPercentage - a.winPercentage);

      return {
        opponents: opponentValues,
        overallStats: {
          totalVotes,
          totalWins,
          winPercentage: totalVotes > 0 ? Math.round(((totalWins / totalVotes) * 100) * 10) / 10 : 0,
        },
        project: {
          id: projectId,
          name: project.name,
        },
      };
    },
  };
}

async function withTransaction(pool, handler) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function computeProjectRanks(executor, tenantId) {
  const [projectRows] = await executor.execute(
    `SELECT id FROM projects WHERE tenant_id = ? AND ${rankedProjectSql('')}`,
    [tenantId],
  );
  const projectIds = projectRows.map((row) => row.id);
  const wins = Object.fromEntries(projectIds.map((id) => [id, 0]));

  const [winRows] = await executor.execute(
    `
      SELECT winner, COUNT(*) AS cnt
      FROM project_rank_votes
      WHERE tenant_id = ?
        AND winner IS NOT NULL
      GROUP BY winner
    `,
    [tenantId],
  );

  for (const row of winRows) {
    wins[row.winner] = Number(row.cnt ?? 0);
  }

  const [pairRows] = await executor.execute(
    `
      SELECT project_a AS projectAId, project_b AS projectBId, winner AS winnerId
      FROM project_rank_votes
      WHERE tenant_id = ?
        AND winner IS NOT NULL
    `,
    [tenantId],
  );

  const sorted = computeRankOrder(projectIds, pairRows);

  let rank = 1;
  for (const projectId of sorted) {
    await executor.execute(
      'UPDATE projects SET `rank` = ? WHERE id = ? AND tenant_id = ?',
      [rank, projectId, tenantId],
    );
    rank += 1;
  }
}

async function projectTaskStats(executor, projectId) {
  const [rows] = await executor.execute(
    `
      SELECT
        COUNT(*) as totalTasks,
        COUNT(CASE WHEN parent_task_id IS NULL THEN 1 END) as topLevelTasks,
        COUNT(CASE WHEN parent_task_id IS NOT NULL THEN 1 END) as subTasks,
        SUM(CASE WHEN points IS NOT NULL THEN points ELSE 0 END) as totalPoints,
        SUM(CASE WHEN target_hour_estimate IS NOT NULL THEN target_hour_estimate ELSE 0 END) as totalEstimatedHours
      FROM tasks
      WHERE project_id = ?
        AND (deleted = 0 OR deleted IS NULL)
        AND pursuit = 0
    `,
    [projectId],
  );

  const row = rows[0] ?? {};
  return {
    subTasks: Number(row.subTasks ?? 0),
    totalEstimatedHours: Number(row.totalEstimatedHours ?? 0),
    totalPoints: Number(row.totalPoints ?? 0),
    totalTasks: Number(row.totalTasks ?? 0),
    topLevelTasks: Number(row.topLevelTasks ?? 0),
  };
}

function projectDescriptionPreview(description, maxLength = 200) {
  const html = String(description ?? '').trim();

  if (!html) {
    return 'No description available.';
  }

  const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length > maxLength ? `${plain.slice(0, maxLength)}...` : plain;
}

export function createMysqlRankingRepository({ pool } = {}) {
  if (!pool) {
    throw new Error('A MySQL pool is required to create the ranking repository.');
  }

  async function getProjectDetail(executor, projectId, userId) {
    const [rows] = await executor.execute(
      `
        SELECT
          p.id,
          p.name,
          p.description,
          ps.project_status_name AS status,
          p.start_date AS startDate,
          p.end_date AS endDate,
          p.created_at AS createdAt,
          p.updated_at AS updatedAt,
          p.rank
        FROM projects p
        LEFT JOIN project_statuses ps ON ps.id = p.project_status
        WHERE p.id = ?
          AND ${rankedProjectSql('p')}
        LIMIT 1
      `,
      [projectId],
    );

    if (!rows[0]) {
      return null;
    }

    const [roleRows] = await executor.execute(
      'SELECT role FROM user_project WHERE project_id = ? AND user_id = ? LIMIT 1',
      [projectId, userId],
    );

    const role = roleRows[0]?.role ?? null;
    const stats = await projectTaskStats(executor, projectId);

    return {
      createdAt: rows[0].createdAt,
      description: sanitizeRichHtml(rows[0].description ?? ''),
      descriptionPreview: projectDescriptionPreview(rows[0].description ?? ''),
      endDate: rows[0].endDate ?? null,
      id: rows[0].id,
      name: rows[0].name,
      rank: rows[0].rank != null ? Number(rows[0].rank) : null,
      startDate: rows[0].startDate ?? null,
      status: rows[0].status ?? '',
      taskStats: stats,
      updatedAt: rows[0].updatedAt,
      userRole: role,
    };
  }

  return {
    async getNextRankPair({ tenantId, userId }) {
      const [rows] = await pool.execute(
        `
          SELECT p1.id AS aId, p2.id AS bId
          FROM projects p1
          JOIN projects p2
            ON p1.id < p2.id
           AND p1.tenant_id = p2.tenant_id
          LEFT JOIN project_rank_votes v
            ON v.tenant_id = ?
           AND v.user_id = ?
           AND (
             (v.project_a = p1.id AND v.project_b = p2.id)
             OR
             (v.project_a = p2.id AND v.project_b = p1.id)
           )
          WHERE p1.tenant_id = ?
            AND ${rankedProjectSql('p1')}
            AND ${rankedProjectSql('p2')}
            AND v.id IS NULL
          ORDER BY RAND()
          LIMIT 1
        `,
        [tenantId, userId, tenantId],
      );

      if (!rows[0]) {
        return null;
      }

      const [projectAId, projectBId] = [rows[0].aId, rows[0].bId];
      const projectA = await getProjectDetail(pool, projectAId, userId);
      const projectB = await getProjectDetail(pool, projectBId, userId);

      if (!projectA || !projectB) {
        return null;
      }

      return {
        projectA,
        projectB,
      };
    },
    async submitVote({ loserId, tenantId, userId, winnerId }) {
      const winner = normalizeId(winnerId);
      const loser = normalizeId(loserId);
      const [a, b] = orderedPair(winner, loser);

      await withTransaction(pool, async (executor) => {
        await executor.execute(
          `
            INSERT INTO project_rank_votes (
              id,
              tenant_id,
              user_id,
              project_a,
              project_b,
              winner,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, NOW())
          `,
          [randomUUID(), tenantId, userId, a, b, winner],
        );

        await computeProjectRanks(executor, tenantId);
      });

      return true;
    },
    async skipPair({ projectAId, projectBId, tenantId, userId }) {
      const [a, b] = orderedPair(projectAId, projectBId);

      await pool.execute(
        `
          INSERT INTO project_rank_votes (
            id,
            tenant_id,
            user_id,
            project_a,
            project_b,
            winner,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, NULL, NOW())
        `,
        [randomUUID(), tenantId, userId, a, b],
      );

      return true;
    },
    async getCompletionStatus({ tenantId, threshold = 70, userId }) {
      const [[projectCountRow]] = await pool.execute(
        `SELECT COUNT(*) AS projectCount FROM projects WHERE tenant_id = ? AND ${rankedProjectSql('')}`,
        [tenantId],
      );
      const projectCount = Number(projectCountRow?.projectCount ?? 0);
      const totalPairs = (projectCount * (projectCount - 1)) / 2;

      const [[voteCountRow]] = await pool.execute(
        'SELECT COUNT(*) AS userVotes FROM project_rank_votes WHERE tenant_id = ? AND user_id = ?',
        [tenantId, userId],
      );
      const userVotes = Number(voteCountRow?.userVotes ?? 0);

      const completionPercentage = totalPairs > 0 ? (userVotes / totalPairs) * 100 : 100;

      return {
        completionPercentage: Math.round(completionPercentage * 10) / 10,
        isComplete: completionPercentage >= threshold,
        threshold,
        totalPairs,
        userVotes,
      };
    },
    async getLeaderboard({ tenantId }) {
      const [rows] = await pool.execute(
        `
          SELECT
            p.id,
            p.name,
            p.rank,
            COALESCE(v.win_count, 0) AS wins,
            COALESCE(v.total_comparisons, 0) AS totalComparisons,
            ps.project_status_name AS status
          FROM projects p
          LEFT JOIN (
            SELECT
              project_id,
              SUM(CASE WHEN project_id = winner THEN 1 ELSE 0 END) AS win_count,
              COUNT(*) AS total_comparisons
            FROM (
              SELECT project_a AS project_id, winner
              FROM project_rank_votes
              WHERE tenant_id = ?
                AND winner IS NOT NULL
              UNION ALL
              SELECT project_b AS project_id, winner
              FROM project_rank_votes
              WHERE tenant_id = ?
                AND winner IS NOT NULL
            ) all_votes
            GROUP BY project_id
          ) v ON p.id = v.project_id
          LEFT JOIN project_statuses ps ON p.project_status = ps.id
          WHERE p.tenant_id = ?
            AND ${rankedProjectSql('p')}
          ORDER BY p.rank IS NULL, p.rank ASC, p.name
        `,
        [tenantId, tenantId, tenantId],
      );

      return rows.map((row) => {
        const wins = Number(row.wins ?? 0);
        const totalComparisons = Number(row.totalComparisons ?? 0);
        const winPercentage = totalComparisons > 0 ? Math.round(((wins / totalComparisons) * 100) * 10) / 10 : 0;

        return {
          id: row.id,
          name: row.name,
          rank: row.rank != null ? Number(row.rank) : null,
          status: row.status ?? '',
          totalComparisons,
          winPercentage,
          wins,
        };
      });
    },
    async getUserVoteHistory({ tenantId, userId }) {
      const [history] = await pool.execute(
        `
          SELECT
            v.created_at AS createdAt,
            v.winner AS winnerId,
            pa.name AS projectAName,
            pb.name AS projectBName,
            pw.name AS winnerName
          FROM project_rank_votes v
          JOIN projects pa ON v.project_a = pa.id
          JOIN projects pb ON v.project_b = pb.id
          LEFT JOIN projects pw ON v.winner = pw.id
          WHERE v.tenant_id = ?
            AND v.user_id = ?
            AND ${rankedProjectSql('pa')}
            AND ${rankedProjectSql('pb')}
          ORDER BY v.created_at DESC
          LIMIT 50
        `,
        [tenantId, userId],
      );

      const [[stats]] = await pool.execute(
        `
          SELECT
            COUNT(*) AS totalVotes,
            COUNT(winner) AS actualVotes,
            COUNT(*) - COUNT(winner) AS skips
          FROM project_rank_votes
          WHERE tenant_id = ?
            AND user_id = ?
        `,
        [tenantId, userId],
      );

      return {
        history,
        stats: {
          actualVotes: Number(stats?.actualVotes ?? 0),
          skips: Number(stats?.skips ?? 0),
          totalVotes: Number(stats?.totalVotes ?? 0),
        },
      };
    },
    async getProjectHeadToHead({ projectId, tenantId }) {
      const [projectRows] = await pool.execute(
        `SELECT id, name FROM projects WHERE id = ? AND tenant_id = ? AND ${rankedProjectSql('')} LIMIT 1`,
        [projectId, tenantId],
      );

      if (!projectRows[0]) {
        return null;
      }

      const [voteRows] = await pool.execute(
        `
          SELECT
            v.project_a AS projectAId,
            v.project_b AS projectBId,
            v.winner AS winnerId,
            v.created_at AS createdAt,
            pa.name AS projectAName,
            pb.name AS projectBName,
            u.name AS voterName
          FROM project_rank_votes v
          JOIN projects pa ON v.project_a = pa.id
          JOIN projects pb ON v.project_b = pb.id
          JOIN users u ON v.user_id = u.id
          WHERE (v.project_a = ? OR v.project_b = ?)
            AND v.tenant_id = ?
            AND v.winner IS NOT NULL
            AND ${rankedProjectSql('pa')}
            AND ${rankedProjectSql('pb')}
          ORDER BY v.created_at DESC
        `,
        [projectId, projectId, tenantId],
      );

      const opponents = new Map();
      let totalWins = 0;
      let totalVotes = 0;

      for (const vote of voteRows) {
        const opponentId = vote.projectAId === projectId ? vote.projectBId : vote.projectAId;
        const opponentName = vote.projectAId === projectId ? vote.projectBName : vote.projectAName;
        const won = vote.winnerId === projectId;

        if (!opponents.has(opponentId)) {
          opponents.set(opponentId, {
            id: opponentId,
            losses: 0,
            name: opponentName,
            totalVotes: 0,
            votes: [],
            winPercentage: 0,
            wins: 0,
          });
        }

        const entry = opponents.get(opponentId);
        entry.votes.push({
          createdAt: vote.createdAt,
          voterName: vote.voterName,
          won,
        });

        if (won) {
          entry.wins += 1;
          totalWins += 1;
        } else {
          entry.losses += 1;
        }

        entry.totalVotes += 1;
        totalVotes += 1;
      }

      const values = [...opponents.values()].map((opponent) => ({
        ...opponent,
        winPercentage: opponent.totalVotes > 0
          ? Math.round(((opponent.wins / opponent.totalVotes) * 100) * 10) / 10
          : 0,
      }));

      values.sort((a, b) => b.winPercentage - a.winPercentage);

      return {
        opponents: values,
        overallStats: {
          totalVotes,
          totalWins,
          winPercentage: totalVotes > 0 ? Math.round(((totalWins / totalVotes) * 100) * 10) / 10 : 0,
        },
        project: {
          id: projectRows[0].id,
          name: projectRows[0].name,
        },
      };
    },
  };
}

