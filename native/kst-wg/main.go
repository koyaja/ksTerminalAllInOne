// kst-wg : client WireGuard en espace utilisateur pour KSTermus.
//
// · Aucune interface réseau système, aucun droit administrateur : la pile
//   TCP/IP du tunnel (gVisor netstack) vit dans ce processus.
// · Configuration reçue en JSON sur stdin (la clé privée ne touche jamais le disque).
// · Expose un proxy SOCKS5 sur 127.0.0.1 protégé par un identifiant aléatoire
//   (RFC 1929) : seul KSTermus peut ouvrir des connexions dans le tunnel.
// · Écrit des événements JSON sur stdout (ready, stats, error) ; s'arrête
//   quand stdin se ferme (KSTermus quitté ou planté).
package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

type Peer struct {
	PublicKey    string   `json:"publicKey"`
	PresharedKey string   `json:"presharedKey"`
	Endpoint     string   `json:"endpoint"`
	AllowedIPs   []string `json:"allowedIPs"`
	Keepalive    int      `json:"keepalive"`
}

type Config struct {
	PrivateKey string   `json:"privateKey"`
	Addresses  []string `json:"addresses"`
	DNS        []string `json:"dns"`
	MTU        int      `json:"mtu"`
	Peers      []Peer   `json:"peers"`
	Listen     string   `json:"listen"`
	User       string   `json:"user"`
	Pass       string   `json:"pass"`
}

var out = json.NewEncoder(os.Stdout)
var outMu sync.Mutex

func emit(v map[string]any) { outMu.Lock(); _ = out.Encode(v); outMu.Unlock() }
func fail(err error)        { emit(map[string]any{"event": "error", "error": err.Error()}); os.Exit(1) }

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println("kst-wg 1.0.0")
		return
	}
	in := bufio.NewReader(os.Stdin)
	line, err := in.ReadBytes('\n')
	if err != nil && len(line) == 0 {
		fail(errors.New("configuration absente sur stdin"))
	}
	var cfg Config
	if err := json.Unmarshal(line, &cfg); err != nil {
		fail(fmt.Errorf("configuration JSON invalide : %w", err))
	}
	if cfg.MTU == 0 {
		cfg.MTU = 1420
	}
	var addrs, dns []netip.Addr
	for _, a := range cfg.Addresses {
		p, err := netip.ParsePrefix(a)
		if err != nil {
			ad, err2 := netip.ParseAddr(a)
			if err2 != nil {
				fail(fmt.Errorf("Address invalide %q", a))
			}
			addrs = append(addrs, ad)
			continue
		}
		addrs = append(addrs, p.Addr())
	}
	for _, d := range cfg.DNS {
		if ad, err := netip.ParseAddr(d); err == nil {
			dns = append(dns, ad)
		}
	}
	tunDev, tnet, err := netstack.CreateNetTUN(addrs, dns, cfg.MTU)
	if err != nil {
		fail(err)
	}
	logger := &device.Logger{Verbosef: device.DiscardLogf, Errorf: device.DiscardLogf}
	if os.Getenv("KST_WG_DEBUG") != "" {
		logger = device.NewLogger(device.LogLevelVerbose, "wg: ")
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), logger)

	var uapi strings.Builder
	fmt.Fprintf(&uapi, "private_key=%s\n", cfg.PrivateKey)
	for _, p := range cfg.Peers {
		fmt.Fprintf(&uapi, "public_key=%s\n", p.PublicKey)
		if p.PresharedKey != "" {
			fmt.Fprintf(&uapi, "preshared_key=%s\n", p.PresharedKey)
		}
		if p.Endpoint != "" {
			ua, err := net.ResolveUDPAddr("udp", p.Endpoint)
			if err != nil {
				fail(fmt.Errorf("Endpoint %s injoignable : %w", p.Endpoint, err))
			}
			ap := ua.AddrPort()
			// IPv4 « mappée » (::ffff:a.b.c.d) → IPv4 pure, sinon envoi sur une socket IPv6
			// (échec « address family not supported » sur les machines sans IPv6).
			ap = netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port())
			fmt.Fprintf(&uapi, "endpoint=%s\n", ap.String())
		}
		if p.Keepalive > 0 {
			fmt.Fprintf(&uapi, "persistent_keepalive_interval=%d\n", p.Keepalive)
		}
		for _, ip := range p.AllowedIPs {
			fmt.Fprintf(&uapi, "allowed_ip=%s\n", ip)
		}
	}
	if err := dev.IpcSet(uapi.String()); err != nil {
		fail(fmt.Errorf("configuration WireGuard refusée : %w", err))
	}
	if err := dev.Up(); err != nil {
		fail(err)
	}

	if cfg.Listen == "" {
		cfg.Listen = "127.0.0.1:0"
	}
	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		fail(err)
	}
	emit(map[string]any{"event": "ready", "socks": ln.Addr().String()})

	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go handle(c, tnet, cfg, len(dns) > 0)
		}
	}()

	go func() {
		for {
			time.Sleep(2 * time.Second)
			s, err := dev.IpcGet()
			if err != nil {
				continue
			}
			var hs, rx, tx int64
			for _, l := range strings.Split(s, "\n") {
				k, v, _ := strings.Cut(l, "=")
				n, _ := strconv.ParseInt(v, 10, 64)
				switch k {
				case "last_handshake_time_sec":
					if n > hs {
						hs = n
					}
				case "rx_bytes":
					rx += n
				case "tx_bytes":
					tx += n
				}
			}
			emit(map[string]any{"event": "stats", "handshake": hs, "rx": rx, "tx": tx})
		}
	}()

	// Fin de stdin = KSTermus parti : on ferme proprement.
	_, _ = io.Copy(io.Discard, in)
	ln.Close()
	dev.Close()
}

// ----- SOCKS5 minimal (CONNECT, authentification utilisateur/mot de passe) -----
func handle(c net.Conn, tnet *netstack.Net, cfg Config, haveDNS bool) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(20 * time.Second))
	buf := make([]byte, 262)
	if _, err := io.ReadFull(c, buf[:2]); err != nil || buf[0] != 5 {
		return
	}
	n := int(buf[1])
	if _, err := io.ReadFull(c, buf[:n]); err != nil {
		return
	}
	hasUP := false
	for _, m := range buf[:n] {
		if m == 2 {
			hasUP = true
		}
	}
	if !hasUP {
		c.Write([]byte{5, 0xff})
		return
	}
	c.Write([]byte{5, 2})
	if _, err := io.ReadFull(c, buf[:2]); err != nil || buf[0] != 1 {
		return
	}
	u := make([]byte, buf[1])
	io.ReadFull(c, u)
	io.ReadFull(c, buf[:1])
	p := make([]byte, buf[0])
	io.ReadFull(c, p)
	if string(u) != cfg.User || string(p) != cfg.Pass {
		c.Write([]byte{1, 1})
		return
	}
	c.Write([]byte{1, 0})

	if _, err := io.ReadFull(c, buf[:4]); err != nil || buf[1] != 1 {
		c.Write([]byte{5, 7, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	var host string
	switch buf[3] {
	case 1:
		io.ReadFull(c, buf[:4])
		host = net.IP(buf[:4]).String()
	case 4:
		io.ReadFull(c, buf[:16])
		host = net.IP(buf[:16]).String()
	case 3:
		io.ReadFull(c, buf[:1])
		l := int(buf[0])
		io.ReadFull(c, buf[:l])
		host = string(buf[:l])
	default:
		c.Write([]byte{5, 8, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	io.ReadFull(c, buf[:2])
	port := binary.BigEndian.Uint16(buf[:2])

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	target := host
	if _, err := netip.ParseAddr(host); err != nil {
		var ips []string
		var err error
		if haveDNS {
			ips, err = tnet.LookupContextHost(ctx, host) // DNS du tunnel
		} else {
			ips, err = net.DefaultResolver.LookupHost(ctx, host) // DNS du système
		}
		if err != nil || len(ips) == 0 {
			c.Write([]byte{5, 4, 0, 1, 0, 0, 0, 0, 0, 0})
			return
		}
		target = ips[0]
	}
	rc, err := tnet.DialContext(ctx, "tcp", net.JoinHostPort(target, strconv.Itoa(int(port))))
	if err != nil {
		c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	defer rc.Close()
	c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
	_ = c.SetDeadline(time.Time{})
	done := make(chan struct{}, 2)
	go func() { io.Copy(rc, c); done <- struct{}{} }()
	go func() { io.Copy(c, rc); done <- struct{}{} }()
	<-done
}
