/**
 * Preparação do texto usado para classificar a falha de um agente.
 *
 * Por que existe: alguns CLIs de IA — o Codex, notadamente — ecoam o prompt
 * inteiro na saída de erro. O OrqPEG envia, dentro do pacote de auditoria, o
 * diff do próprio código-fonte, e esse código contém literais como
 * "usage limit", "not logged in" e "is not recognized as an internal or
 * external command" (são os marcadores de detecção). Varrer a saída inteira faz
 * o adaptador "ler a si mesmo" e classificar uma falha comum como limite de
 * cota, falta de autenticação ou ausência do executável.
 *
 * A correção tem duas camadas:
 *   1. remover do texto as ocorrências literais da instrução enviada;
 *   2. limitar a varredura a uma janela do começo e do fim da saída, porque é
 *      onde um CLI escreve o erro de verdade — nunca no meio de um megabyte
 *      de eco.
 */

/** Tamanho de cada janela (início e fim) considerada na varredura. */
export const SCAN_WINDOW_BYTES = 8_000;

/** Abaixo deste tamanho não vale a pena recortar: o texto já é o próprio erro. */
const MIN_SIZE_TO_WINDOW = SCAN_WINDOW_BYTES * 2;

/**
 * Remove o eco da instrução e recorta o miolo, devolvendo o texto minúsculo
 * pronto para a busca por marcadores.
 */
export function buildFailureScanText(input: {
  stderr: string;
  output: string;
  /** Instrução enviada ao agente; será removida do texto varrido. */
  instruction: string;
  /** Quando falso, a saída principal não entra na varredura. */
  includeOutput: boolean;
}): string {
  const parts = [input.stderr, input.includeOutput ? input.output : ''];
  let text = parts.filter((part) => part.length > 0).join('\n');

  text = stripInstructionEcho(text, input.instruction);

  if (text.length > MIN_SIZE_TO_WINDOW) {
    const head = text.slice(0, SCAN_WINDOW_BYTES);
    const tail = text.slice(-SCAN_WINDOW_BYTES);
    text = `${head}\n${tail}`;
  }

  return text.toLowerCase();
}

/**
 * Remove ocorrências da instrução no texto.
 *
 * A remoção é feita por blocos: o eco costuma vir reformatado (quebras de linha
 * diferentes, prefixos de terminal), então além da remoção literal do todo,
 * retiramos também os trechos longos da instrução que aparecerem tal e qual.
 */
export function stripInstructionEcho(text: string, instruction: string): string {
  if (instruction.length === 0 || text.length === 0) return text;

  let result = text;

  if (instruction.length >= 32 && result.includes(instruction)) {
    result = result.split(instruction).join(' ');
  }

  const CHUNK = 2_000;
  if (instruction.length > CHUNK) {
    for (let start = 0; start < instruction.length; start += CHUNK) {
      const chunk = instruction.slice(start, start + CHUNK);
      if (chunk.length < 200) continue;
      if (result.includes(chunk)) {
        result = result.split(chunk).join(' ');
      }
    }
  }

  return result;
}

/** Busca marcadores, sem diferenciar maiúsculas. O texto já deve vir minúsculo. */
export function containsMarker(text: string, markers: readonly string[]): boolean {
  return markers.some((marker) => text.includes(marker));
}
