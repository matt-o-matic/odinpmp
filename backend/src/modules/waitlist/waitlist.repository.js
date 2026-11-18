// Access requests from the marketing site's "Request access" form.

/** Migration 0075: the table the repository below always assumed, which no migration had created. */
export async function ensureMysqlWaitlistSchema(executor) {
  await executor.execute(`
    CREATE TABLE IF NOT EXISTS waitlist_signups (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(320) NOT NULL,
      company VARCHAR(100) NOT NULL DEFAULT '',
      company_size VARCHAR(50) NOT NULL DEFAULT '',
      industry VARCHAR(100) NOT NULL DEFAULT '',
      comments TEXT NULL,
      beta_interest TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_waitlist_signups_email (email),
      KEY idx_waitlist_signups_created_at (created_at)
    )
  `);
}

export function createInMemoryWaitlistRepository(seed = []) {
  const items = [...seed];

  return {
    items,
    async findByEmail(email) {
      const normalizedEmail = email.toLowerCase();
      return items.find((item) => item.email.toLowerCase() === normalizedEmail) ?? null;
    },
    async create(input) {
      const signup = {
        id: String(items.length + 1),
        createdAt: new Date().toISOString(),
        ...input,
      };

      items.push(signup);
      return signup;
    },
  };
}

export function createMysqlWaitlistRepository({ pool }) {
  if (!pool) {
    throw new Error('A MySQL pool is required to create the waitlist repository.');
  }

  return {
    async findByEmail(email) {
      const [rows] = await pool.execute(
        `
          SELECT
            id,
            name,
            email,
            company,
            company_size AS companySize,
            industry,
            comments,
            beta_interest AS betaInterest,
            created_at AS createdAt
          FROM waitlist_signups
          WHERE email = ?
          LIMIT 1
        `,
        [email],
      );

      return rows[0] ?? null;
    },
    async create(input) {
      const [result] = await pool.execute(
        `
          INSERT INTO waitlist_signups (
            name,
            email,
            company,
            company_size,
            industry,
            comments,
            beta_interest
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          input.name,
          input.email,
          input.company,
          input.companySize,
          input.industry,
          input.comments,
          input.betaInterest ? 1 : 0,
        ],
      );

      return {
        id: String(result.insertId),
        createdAt: new Date().toISOString(),
        ...input,
      };
    },
  };
}
