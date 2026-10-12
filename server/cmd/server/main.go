// Command server runs the Watch Party Sync server.
package main

import (
	"flag"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/ryanjguo/insync/server/internal/server"
)

func main() {
	addr := flag.String("addr", ":8080", "listen address")
	static := flag.String("static", "", "directory to serve at / (e.g. ../testpage)")
	flag.Parse()

	srv := &http.Server{
		Addr:              *addr,
		Handler:           server.New(*static).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	slog.Info("listening", "addr", *addr, "static", *static)
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("server stopped", "err", err)
		os.Exit(1)
	}
}
