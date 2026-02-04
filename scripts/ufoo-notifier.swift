#!/usr/bin/env swift

import Foundation
import UserNotifications

// 解析命令行参数
func parseArgs() -> [String: String] {
    var args: [String: String] = [:]
    let arguments = CommandLine.arguments

    var i = 1
    while i < arguments.count {
        let arg = arguments[i]
        if arg.hasPrefix("-") {
            let key = arg.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
            if i + 1 < arguments.count {
                args[key] = arguments[i + 1]
                i += 2
            } else {
                i += 1
            }
        } else {
            i += 1
        }
    }

    return args
}

let args = parseArgs()
let title = args["title"] ?? "Ufoo"
let subtitle = args["subtitle"] ?? ""
let message = args["message"] ?? ""
let sound = args["sound"] ?? "default"
let identifier = args["identifier"] ?? UUID().uuidString
let executeScript = args["execute"] ?? ""

// 请求通知权限
let center = UNUserNotificationCenter.current()
let semaphore = DispatchSemaphore(value: 0)

center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
    if granted {
        // 创建通知内容
        let content = UNMutableNotificationContent()
        content.title = title
        if !subtitle.isEmpty {
            content.subtitle = subtitle
        }
        content.body = message

        if sound == "default" {
            content.sound = .default
        }

        // 添加执行脚本的用户信息
        if !executeScript.isEmpty {
            content.userInfo = ["executeScript": executeScript]
        }

        // 创建通知请求
        let request = UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: nil
        )

        // 发送通知
        center.add(request) { error in
            if let error = error {
                print("Error: \(error.localizedDescription)")
            }
            semaphore.signal()
        }
    } else {
        print("Notification permission denied")
        semaphore.signal()
    }
}

semaphore.wait()

// 等待一小段时间确保通知发送
Thread.sleep(forTimeInterval: 0.5)
