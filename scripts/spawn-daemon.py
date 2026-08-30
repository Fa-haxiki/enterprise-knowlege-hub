#!/usr/bin/env python3
"""以守护进程方式启动命令：fork + setsid 脱离终端会话与进程组。

避免脚本退出后（尤其在 IDE 托管终端中）后台服务被连带清理。
用法: spawn-daemon.py <log_file> <cwd> <cmd...>，输出子进程 PID。
"""
import os
import sys


def main() -> None:
    if len(sys.argv) < 4:
        print("usage: spawn-daemon.py <log_file> <cwd> <cmd...>", file=sys.stderr)
        sys.exit(2)
    log_file, cwd, cmd = sys.argv[1], sys.argv[2], sys.argv[3:]

    pid = os.fork()
    if pid > 0:
        print(pid)
        return

    os.setsid()
    os.chdir(cwd)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    log = os.open(log_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND)
    os.dup2(log, 1)
    os.dup2(log, 2)
    os.execvp(cmd[0], cmd)


if __name__ == "__main__":
    main()
