export function notFoundHandler(request, response) {
  response.status(404).json({
    ok: false,
    error: 'Route not found.',
    path: request.originalUrl,
  });
}
