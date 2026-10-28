// Pair WireGuard de test (serveur) : écoute en UDP, et expose dans le tunnel
// un port TCP (10.66.0.1:22) redirigé vers une cible locale (sshd de test).
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

type Cfg struct {
	PrivateKey, Address, PeerPublicKey, PeerAllowed, Target string
	ListenPort, TunnelPort                                  int
}

func main() {
	var c Cfg
	line, _ := bufio.NewReader(os.Stdin).ReadBytes('\n')
	if err := json.Unmarshal(line, &c); err != nil {
		panic(err)
	}
	addr := netip.MustParseAddr(c.Address)
	tunDev, tnet, err := netstack.CreateNetTUN([]netip.Addr{addr}, nil, 1420)
	if err != nil {
		panic(err)
	}
	logger := &device.Logger{Verbosef: device.DiscardLogf, Errorf: device.DiscardLogf}
	if os.Getenv("KST_WG_DEBUG") != "" {
		logger = device.NewLogger(device.LogLevelVerbose, "wg: ")
	}
	dev := device.NewDevice(tunDev, conn.NewDefaultBind(), logger)
	if err := dev.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=%d\npublic_key=%s\nallowed_ip=%s\n", c.PrivateKey, c.ListenPort, c.PeerPublicKey, c.PeerAllowed)); err != nil {
		panic(err)
	}
	dev.Up()
	ln, err := tnet.ListenTCP(&net.TCPAddr{IP: addr.AsSlice(), Port: c.TunnelPort})
	if err != nil {
		panic(err)
	}
	fmt.Println("peer ready")
	for {
		cl, err := ln.Accept()
		if err != nil {
			return
		}
		go func() {
			defer cl.Close()
			t, err := net.Dial("tcp", c.Target)
			if err != nil {
				return
			}
			defer t.Close()
			go io.Copy(t, cl)
			io.Copy(cl, t)
		}()
	}
}
