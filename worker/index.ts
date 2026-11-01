export default {
  fetch(request: Request, _env: Env): Response {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({
        status: "ok",
        service: "web-ts7-vite-worker",
        runtime: "cloudflare-workers",
        timestamp: new Date().toISOString(),
      });
    }

    return Response.json(
      {
        status: "not_found",
        path: url.pathname,
      },
      { status: 404 },
    );
  },
} satisfies ExportedHandler<Env>;
