// Command server runs the Watch Party Sync server.
package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/ryanjguo/insync/server/internal/server"
)

// shutdownTimeout is how long open connections get to finish when the server
// is asked to stop (hosts send SIGTERM before replacing an instance).
const shutdownTimeout = 5 * time.Second

func main() {
	addr := flag.String("addr", defaultAddr(), "listen address (default :$PORT if PORT is set, else :8080)")
	static := flag.String("static", "", "directory to serve at / (e.g. ../testpage)")
	flag.Parse()

	app := server.New(*static)
	srv := &http.Server{
		Addr:              *addr,
		Handler:           app.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	go app.SweepRooms(ctx)
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()

	slog.Info("listening", "addr", *addr, "static", *static)
	err := srv.ListenAndServe()
	stop()
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server stopped", "err", err)
		os.Exit(1)
	}
	slog.Info("server stopped")
}

// defaultAddr listens on $PORT when the host sets it (Fly.io, Render and most
// others do), and on :8080 otherwise.
func defaultAddr() string {
	if port := os.Getenv("PORT"); port != "" {
		return ":" + port
	}
	return ":8080"
}
