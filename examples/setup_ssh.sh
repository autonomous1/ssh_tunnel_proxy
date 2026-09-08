#!/usr/bin/env bash
# Example of a plain OpenSSH reverse forward. The library replaces this
# pattern when you need reconnect, state, and more than one connection.
#
# Replace user@host.example.net with your SSH login.

ssh -N \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -R 127.0.0.1:8380:127.0.0.1:22 \
  user@host.example.net
