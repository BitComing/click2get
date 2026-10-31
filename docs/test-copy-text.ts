// 复制出去的纯文本：node --experimental-strip-types docs\test-copy-text.ts
//
// 规矩（见 editor/clipboard.ts）：空行不留，**内容与内容之间的换行照留**。
// 换行符不止 \n —— 单独的 \r、U+2028/2029 都算换行，认不出来就会把几行粘成一行。
import { cleanCopyText } from '../src/editor/clipboard.ts'

let failed = 0
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`PASS  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name}\n      期望 ${e}\n      实际 ${a}`)
  }
}

// 每一行都留着，行与行之间就是一个换行
check('多行：换行都在', cleanCopyText('第一行\n第二行\n第三行'), '第一行\n第二行\n第三行')

// 空行（空段落 / 块边界 / 图片行留下的）不带走，但两边的内容仍然是分开的两行
check('空行不留', cleanCopyText('第一行\n\n第二行'), '第一行\n第二行')
check('连续空行也不留', cleanCopyText('第一行\n\n\n\n第二行'), '第一行\n第二行')
check('只有空白的行不算内容', cleanCopyText('第一行\n   \n第二行'), '第一行\n第二行')
check('开头的空行不留', cleanCopyText('\n\n第一行'), '第一行')
check('结尾的空行不留', cleanCopyText('第一行\n\n'), '第一行')

// 换行的三种写法都要认，否则几行会被粘成一行
check('CRLF', cleanCopyText('第一行\r\n第二行'), '第一行\n第二行')
check('单独的 \\r', cleanCopyText('第一行\r第二行'), '第一行\n第二行')
check('U+2028', cleanCopyText('第一行\u2028第二行'), '第一行\n第二行')
check('U+2029', cleanCopyText('第一行\u2029第二行'), '第一行\n第二行')

check('空字符串', cleanCopyText(''), '')
check('纯空行 → 空', cleanCopyText('\n \n\t\n'), '')

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)