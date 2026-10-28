'use strict';
// Détection des commandes dangereuses (destruction de données, arrêt du serveur,
// réécriture de disque, SQL destructeur…). Utilisé avant d'envoyer « Entrée »
// sur un host marqué PROD. Volontairement prudent : mieux vaut une confirmation
// de trop qu'un `rm -rf /` en production.
(function () {
  const R = [
    // Fichiers
    { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z-]+\s+)*(\/|\/\*|~|~\/|\*|\.|\.\/|\.\*|\$HOME|\/(etc|usr|var|bin|boot|lib|lib64|opt|root|home|srv|sbin)(\/\S*)?)(\s|;|&|\||$)/, why: 'Suppression récursive d\'un dossier système ou de tout le contenu' },
    { re: /\brm\s+(-[a-zA-Z]*\s+)*--no-preserve-root/, why: 'rm --no-preserve-root' },
    { re: /\bfind\b.*\s-delete\b/, why: 'find … -delete (suppression en masse)' },
    { re: /\bshred\b/, why: 'Effacement irréversible (shred)' },
    { re: /\b(chmod|chown|chgrp)\s+(-[a-zA-Z]*R[a-zA-Z]*|--recursive)\b.*\s(\/|\/(etc|usr|var|bin|boot|lib|home|root))(\s|$)/, why: 'Changement récursif de droits sur un dossier système' },
    { re: /\bchmod\s+(-R\s+)?0?777\s+\/(\s|$)/, why: 'chmod 777 sur la racine' },
    { re: />\s*\/etc\/(passwd|shadow|sudoers|fstab|hosts)\b/, why: 'Écrasement d\'un fichier système critique' },
    // Disques
    { re: /\bmkfs(\.\w+)?\b/, why: 'Formatage d\'un système de fichiers (mkfs)' },
    { re: /\bdd\b.*\bof=\/dev\/(sd|nvme|vd|xvd|hd|mmcblk|disk)/, why: 'Écriture brute sur un disque (dd of=/dev/…)' },
    { re: />\s*\/dev\/(sd|nvme|vd|xvd|hd)[a-z0-9]*\b/, why: 'Écriture brute sur un disque' },
    { re: /\b(wipefs|fdisk|sfdisk|parted|gdisk)\b/, why: 'Modification des partitions' },
    { re: /\b(lvremove|vgremove|pvremove|zpool\s+destroy|zfs\s+destroy)\b/, why: 'Suppression de volume' },
    // Système
    { re: /(^|[;&|]\s*|\bsudo\s+)(shutdown|reboot|halt|poweroff)\b/, why: 'Arrêt / redémarrage du serveur' },
    { re: /\b(systemctl|service)\s+(\S+\s+)?(reboot|poweroff|halt|kexec)\b/, why: 'Arrêt / redémarrage du serveur' },
    { re: /\binit\s+[06]\b/, why: 'Arrêt / redémarrage du serveur (init)' },
    { re: /\bsystemctl\s+(stop|disable|mask)\s+(ssh|sshd|network|networking|NetworkManager|firewalld|docker|nginx|apache2|httpd|mysql|mariadb|postgresql|mongod|redis)/, why: 'Arrêt d\'un service critique' },
    { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'Fork bomb' },
    { re: /\bkill\s+(-9\s+|-KILL\s+)?-?1(\s|$)/, why: 'kill de tous les processus' },
    { re: /\b(iptables|ip6tables)\s+(-F|--flush|-X|-P\s+INPUT\s+DROP)/, why: 'Vidage / blocage du pare-feu (risque de perdre l\'accès SSH)' },
    { re: /\bufw\s+(reset|disable|default\s+deny)/, why: 'Modification globale du pare-feu' },
    { re: /\b(userdel|deluser)\b/, why: 'Suppression d\'un utilisateur' },
    { re: /\bpasswd\s+-[dl]\b|\busermod\s+.*-L\b/, why: 'Verrouillage / suppression de mot de passe' },
    { re: /\b(apt|apt-get|yum|dnf)\s+(-y\s+)?(remove|purge|autoremove)\b.*\b(openssh|linux-image|systemd|libc6|sudo|python3?)\b/, why: 'Désinstallation d\'un paquet système vital' },
    { re: /\bcrontab\s+-r\b/, why: 'Suppression de toute la crontab' },
    { re: /\bhistory\s+-c\b|\bunset\s+HISTFILE\b/, why: 'Effacement de l\'historique' },
    // Conteneurs / orchestration
    { re: /\bdocker\s+(system|volume|image|container)\s+prune\b.*(-a|--all|-f|--force|--volumes)/, why: 'Suppression en masse Docker' },
    { re: /\bdocker\s+(rm|rmi)\s+.*(-f|--force).*\$\(/, why: 'Suppression forcée de tous les conteneurs / images' },
    { re: /\bdocker[- ]compose\s+down\b.*(-v|--volumes)/, why: 'docker compose down -v (supprime les volumes = données)' },
    { re: /\bkubectl\s+delete\b.*(--all\b|\s(ns|namespace|namespaces|pv|pvc|node|nodes)\b)/, why: 'Suppression Kubernetes en masse' },
    { re: /\bhelm\s+(uninstall|delete)\b/, why: 'Désinstallation Helm' },
    { re: /\bterraform\s+(destroy|apply\s+.*-auto-approve)/, why: 'Terraform destroy / apply automatique' },
    // Git
    { re: /\bgit\s+push\b.*(\s-f\b|--force(?!-with-lease))/, why: 'git push --force (écrase l\'historique distant)' },
    { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/, why: 'Perte des modifications locales (git reset --hard / clean -f)' },
    // Bases de données
    { re: /\bdrop\s+(database|schema|table|user|role)\b/i, why: 'SQL : DROP (suppression définitive)' },
    { re: /\btruncate\s+(table\s+)?\w/i, why: 'SQL : TRUNCATE (vide la table)' },
    { re: /\bdelete\s+from\s+[\w."`]+\s*(;|$)/i, why: 'SQL : DELETE sans WHERE (vide la table)' },
    { re: /\bupdate\s+[\w."`]+\s+set\s+(?![\s\S]*\bwhere\b)[\s\S]*?(;|$)/i, why: 'SQL : UPDATE sans WHERE (modifie toutes les lignes)' },
    { re: /\b(dropdb|dropuser)\b/, why: 'PostgreSQL : suppression de base / utilisateur' },
    { re: /\bmysqladmin\b.*\bdrop\b/, why: 'MySQL : suppression de base' },
    { re: /\bflushall\b|\bflushdb\b/i, why: 'Redis : FLUSHALL / FLUSHDB (vide les données)' },
    { re: /\.drop(Database)?\(\s*\)/, why: 'MongoDB : drop()' }
  ];

  // Extrait la commande d'une ligne d'écran en retirant l'invite (user@host:~$ , # , mysql> , db=# …).
  function stripPrompt(line) {
    const s = String(line || '').replace(/\s+$/, '');
    if (/^.{0,120}?(?:[$#%>❯»➜]|\]\$|\]#)$/.test(s) && !/\s/.test(s.slice(-2, -1) || 'x')) return ''; // invite seule
    const m = s.match(/^.{0,120}?(?:[$#%>❯»➜]|\]\$|\]#)\s+(?=\S)/);
    return (m ? s.slice(m[0].length) : s).trim();
  }

  function check(command) {
    const cmd = String(command || '').trim();
    if (!cmd) return [];
    const hits = [];
    for (const r of R) if (r.re.test(cmd) && !hits.includes(r.why)) hits.push(r.why);
    return hits;
  }

  const api = { check, stripPrompt, rules: R };
  if (typeof module !== 'undefined') module.exports = api; else window.KST_DANGER = api;
})();
