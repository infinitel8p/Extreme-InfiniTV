; NSIS installer hook for the LAN TV receiver's Windows firewall rule.
;
; Consent model: Windows Defender Firewall itself is the primary gate. The
; first time the receiver binds its listening socket, Windows shows its own
; "Allow this app to communicate" prompt (private networks checked by
; default, public unchecked); accepting it creates the rule Windows wants,
; declining it creates a persistent Windows-named block rule. Settings ->
; TV receiver surfaces that state and offers a recovery button
; (receiver_firewall_allow in firewall.rs) that clears any block rule and
; adds our own named allow rule scoped to private/domain networks, behind a
; single UAC prompt. We deliberately do not add an allow rule at install
; time anymore: that ran on all profiles (including Public) without asking,
; which is broader than the OS prompt's own default and skips user consent.
;
; This hook only cleans up on uninstall: it removes the named rules the
; in-app recovery flow may have created (TCP and UDP, plus the pre-split
; legacy single rule from older installs) so uninstalling leaves no firewall
; rule behind. It runs only when the uninstall is elevated (perMachine, or
; currentUser with an admin prompt accepted); non-elevated uninstalls
; silently skip since netsh delete needs admin rights.
;
; Keep these rule names identical to RECEIVER_FIREWALL_RULE_NAME,
; RECEIVER_FIREWALL_RULE_NAME_TCP and RECEIVER_FIREWALL_RULE_NAME_UDP in
; src-tauri/src/firewall.rs.

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToStack 'netsh advfirewall firewall delete rule name="Extreme InfiniTV Receiver"'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'netsh advfirewall firewall delete rule name="Extreme InfiniTV Receiver (TCP)"'
  Pop $0
  Pop $1
  nsExec::ExecToStack 'netsh advfirewall firewall delete rule name="Extreme InfiniTV Receiver (UDP)"'
  Pop $0
  Pop $1
!macroend
