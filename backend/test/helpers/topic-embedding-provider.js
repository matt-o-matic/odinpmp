// A stand-in for OpenAI embeddings in the semantic search tests:
// each vector counts the words of a few topics, so texts on one topic are close whatever their
// wording. A text with no topic words gets a zero vector, which matches nothing.

const TOPICS = [
  ['payroll', 'salary', 'salaries', 'wages', 'paycheck', 'paid', 'payday'],
  ['travel', 'trip', 'flight', 'flights', 'hotel', 'offsite', 'journey'],
  ['security', 'password', 'passwords', 'breach', 'credentials', 'login'],
  ['weather', 'rain', 'storm', 'forecast', 'snow'],
];

export function topicProvider({ dimensions = TOPICS.length, failing = false, model = 'fake-large' } = {}) {
  const calls = { batches: [], queries: [] };
  // A text with no topic words gets a zero vector, which matches nothing.
  const vector = (text) => {
    const words = String(text).toLowerCase().split(/[^a-z]+/);
    return TOPICS.map((topic) => words.filter((word) => topic.includes(word)).length);
  };
  const embedding = ({ content, title }) => ({ contentHash: 'hash', dimensions, embeddedAt: new Date().toISOString(), model, vector: vector(`${title} ${content}`) });
  return {
    calls,
    dimensions,
    model,
    async embed(input) {
      if (failing) throw new Error('embeddings are down');
      calls.queries.push(input.content);
      return embedding(input);
    },
    async embedMany(inputs) {
      if (failing) throw new Error('embeddings are down');
      calls.batches.push(inputs.map((input) => input.title));
      return inputs.map(embedding);
    },
  };
}

