'use strict'

const fs = require('fs')
const path = require('path')

/**
 * As telas do SET Mesa Nuvem moram em arquivos .html de verdade, não dentro de
 * uma string aqui. É mais fácil de ler, de corrigir e de abrir no navegador
 * durante o desenvolvimento.
 *
 * Ficam em memória: são dois arquivos pequenos e o disco não precisa ser lido
 * a cada visita. Trocar a tela exige reiniciar o servidor, que é o que já
 * acontece a cada versão nova.
 */

const PASTA = path.join(__dirname, '..', '..', 'publico', 'nuvem')
const ler = nome => fs.readFileSync(path.join(PASTA, nome), 'utf8')

const ENTRADA = ler('entrar.html')
const SISTEMA = ler('sistema.html')

module.exports = {
  telaDeEntrada: () => ENTRADA,
  telaDoSistema: () => SISTEMA
}
