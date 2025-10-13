package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"time"
)

type LogLevel int

const (
	LogLevelDebug LogLevel = iota
	LogLevelInfo
	LogLevelWarn
	LogLevelError
)

type Logger struct {
	level  LogLevel
	logger *log.Logger
}

func NewLogger(levelStr string) *Logger {
	var level LogLevel
	switch strings.ToLower(levelStr) {
	case "debug":
		level = LogLevelDebug
	case "info":
		level = LogLevelInfo
	case "warn":
		level = LogLevelWarn
	case "error":
		level = LogLevelError
	default:
		level = LogLevelInfo
	}

	return &Logger{
		level:  level,
		logger: log.New(os.Stdout, "", 0),
	}
}

func (l *Logger) log(level LogLevel, levelStr, msg string, args ...interface{}) {
	if level < l.level {
		return
	}

	timestamp := time.Now().Format("2006-01-02 15:04:05")
	prefix := fmt.Sprintf("[%s] [%s] ", timestamp, levelStr)

	if len(args) > 0 {
		argsStr := ""
		for i := 0; i < len(args); i += 2 {
			if i+1 < len(args) {
				argsStr += fmt.Sprintf(" %v=%v", args[i], args[i+1])
			}
		}
		l.logger.Printf("%s%s%s", prefix, msg, argsStr)
	} else {
		l.logger.Printf("%s%s", prefix, msg)
	}
}

func (l *Logger) Debug(msg string, args ...interface{}) {
	l.log(LogLevelDebug, "DEBUG", msg, args...)
}

func (l *Logger) Info(msg string, args ...interface{}) {
	l.log(LogLevelInfo, "INFO", msg, args...)
}

func (l *Logger) Warn(msg string, args ...interface{}) {
	l.log(LogLevelWarn, "WARN", msg, args...)
}

func (l *Logger) Error(msg string, args ...interface{}) {
	l.log(LogLevelError, "ERROR", msg, args...)
}

