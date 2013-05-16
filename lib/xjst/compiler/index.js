var esprima = require('esprima'),
    uglify = require('uglify-js'),
    estraverse = require('estraverse'),
    vm = require('vm'),
    assert = require('assert');

var xjst = require('../../xjst');

// Get required constructors
var Template = require('./template').Template;
var Predicate = require('./predicate').Predicate;
var Group = require('./group').Group;
var utils = xjst.utils;

// Compiler constructor
function Compiler(options) {
  this.options = options || {};
  this.idHash = {};
  this.idSecondary = {};
  this.idCount = 0;
  this.bodyId = 0;
  this.applyFlags = 0;
  this.ctx = { type: 'Identifier', name: '__$ctx' };
  this.renderStack = [];
  this.renderHistory = [];
  this.sharedBodies = {};
  this.program = null;
};
exports.Compiler = Compiler;

exports.create = function create(options) {
  return new Compiler(options);
};

// Generate source code from input code
Compiler.prototype.generate = function generate(code) {
  if (this.options['no-opt'] || this.options.optimize === false) {
    return utils.run.toString() + ';\n' +
           'exports.apply = function apply() {\n' +
           '  return applyc(this);\n' +
           '};' +
           'function applyc(ctx) {\n' +
           '  return run(templates, ctx);\n' +
           '};\n' +
           'try {\n' +
           '  applyc({ $init:true, $exports: exports });\n' +
           '} catch (e) {\n' +
           '  // Just ignore any errors\n' +
           '}\n' +
           'function templates(template, local, apply, applyNext, oninit) {\n' +
           code +
           '};';
  }

  var ast = esprima.parse(code);
  assert.equal(ast.type, 'Program');

  ast = this.translate(ast);

  var uast = uglify.AST_Node.from_mozilla_ast(ast);

  return uast.print_to_string();
};

// Compile source to js function
Compiler.prototype.compile = function compile(code) {
  var out = this.generate(code),
      exports = {};

  console.log(out);
  vm.runInNewContext(out, { exports: exports, console: console });

  return exports;
};

// Run compiler in phases to translate AST to AST
Compiler.prototype.translate = function translate(ast) {
  // 1. Get all template()() invokations (and other chunks of code)
  var program = this.getTemplates(ast);

  // 2. Transform template predicates in a compiler-readable form
  program.templates = program.templates.map(this.transformTemplates.bind(this));

  var result = this._translate2(program, false);

  // 6. Add shared bodies to result
  this.addBodies(result);

  return result;
};

Compiler.prototype._translate2 = function translate2(program, bodyOnly) {
  var old = this.program;
  this.program = program;

  // 3. Roll-out local() and apply/applyNext() calls
  program.templates.forEach(function(template) {
    template.rollOut();
  });

  // 4. Group templates
  program.templates = this.sortGroup(program.templates);

  // Restore `this.program`
  this.program = old;

  // 5. Render program back to AST form
  return this.render(program, bodyOnly);
};

// Filter out templates from program's body
Compiler.prototype.getTemplates = function getTemplates(ast) {
  var other = [],
      init = [];

  return {
    templates: ast.body.filter(function(stmt) {
      function fail() {
        other.push(stmt);
        return false;
      };

      if (stmt.type !== 'ExpressionStatement') return fail();

      var expr = stmt.expression;
      if (expr.type !== 'CallExpression') return fail();

      var callee = expr.callee;
      if (callee.type === 'CallExpression') {
        if (callee.callee.type !== 'Identifier' ||
            callee.callee.name !== 'template') {
          return fail();
        }
      } else if (callee.type === 'Identifier' && callee.name === 'oninit') {
        init = init.concat(expr.arguments);
        return false;
      } else {
        return fail();
      }

      return true;
    }).reverse(),
    init: init,
    other: other
  };
};

// Get unique id for a javascript value
Compiler.prototype.getId = function getId(value) {
  var key = JSON.stringify(value);

  if (this.idHash.hasOwnProperty(key)) {
    this.idHash[key].score++;
    return this.idHash[key].id;
  }

  var id = this.idCount++;
  this.idSecondary[id] = this.idHash[key] = { id: id, value: value, score: 1 };

  return id;
};

// Get score for unique javascript value
Compiler.prototype.getScore = function getScore(id) {
  if (!this.idSecondary.hasOwnProperty(id)) return 0;

  return this.idSecondary[id].score;
};

// Return unique apply flag
Compiler.prototype.getApplyFlag = function getApplyFlag() {
  return {
    type: 'Literal',
    value: '__$a' + this.applyFlags++
  };
};

// Replace `this` with `__$ctx`
Compiler.prototype.replaceThis = function replaceThis(stmt) {
  var ctx = this.ctx;
  estraverse.replace(stmt, {
    enter: function(node, parent, notify) {
      if (node.type === 'ThisExpression') {
        return ctx;
      } else if (node.type === 'FunctionDeclaration' ||
                 node.type === 'FunctionExpression') {
        this.skip();
      }
    }
  });
  return stmt;
};

Compiler.prototype.addChange = function addChange(predicate) {
  var predicates = Array.isArray(predicate) ? predicate : [ predicate ];

  this.renderHistory.push(predicates.length);
  for (var i = 0; i < predicates.length; i++) {
    this.renderStack.push(predicates[i]);
  }
};

Compiler.prototype.revertChange = function revertChange() {
  if (this.renderHistory.length === 0) throw new Error('Render OOB');
  var n = this.renderHistory.pop();
  for (var i = 0; i < n; i++) {
    this.renderStack.pop();
  }
};

Compiler.prototype.registerBody = function registerBody(body) {
  this.sharedBodies[body.id] = body;
};

Compiler.prototype.addBodies = function addBodies(result) {
  Object.keys(this.sharedBodies).forEach(function(id) {
    var body = this.sharedBodies[id];

    result.body.push({
      type: 'FunctionDeclaration',
      id: this.getBodyName(body),
      params: [ this.ctx ],
      defaults: [],
      rest: null,
      generator: false,
      expression: false,
      body: {
        type: 'BlockStatement',
        body: body.render(true).apply
      }
    });
  }, this);
};

Compiler.prototype.getBodyName = function getBodyName(body) {
  assert(body.shared);
  assert(this.sharedBodies.hasOwnProperty(body.id));
  return { type: 'Identifier', name: '__$b' + body.id };
};

// Transform AST templates into readable form
Compiler.prototype.transformTemplates = function transformTemplates(template) {
  var expr = template.expression,
      predicates = expr.callee.arguments,
      body = expr.arguments[0] || { type: 'Identifier', name: 'undefined' };

  function isConst(val) {
    return val.type === 'Literal';
  }

  // Translate all predicates to `a === c` form
  // and map as { expr, value } pair
  predicates = predicates.map(function(pred) {
    var expr,
        value;

    if (pred.type === 'FunctionExpression' && pred.body.body.length === 1 &&
        pred.body.body[0].type === 'ReturnStatement') {
      pred = pred.body.body[0].argument;
    }

    if (pred.type === 'BinaryExpression' && pred.operator === '===') {
      if (isConst(pred.right)) {
        // expr === const
        expr = pred.left;
        value = pred.right;
      } else {
        // const === expr
        expr = pred.right;
        value = pred.left;
      }
    } else {
      // expr <=> !(expr) === false
      expr = {
        type: 'UnaryExpression',
        prefix: true,
        operator: '!',
        argument: pred
      };
      value = { type: 'Literal', value: false };
    }

    return new Predicate(this, expr, value);
  }, this);

  return new Template(this, predicates, body);
};

// Sort and group templates by first predicate
// (recursively)
Compiler.prototype.sortGroup = function sortGroup(templates) {
  var self = this,
      out = templates.slice();

  // Sort predicates in templates by popularity
  templates.forEach(function(template) {
    template.predicates.sort(function(a, b) {
      return b.getScore() - a.getScore();
    });
  });

  var groups = [];

  // Group templates by first predicate
  groups.push(templates.reduce(function(acc, template) {
    if (acc.length === 0) return [ template ];

    if (template.predicates.length === 0 ||
        acc[0].predicates.length === 0 ||
        acc[0].predicates[0].id !== template.predicates[0].id) {
      groups.push(acc);
      return [ template ];
    }

    acc.push(template);
    return acc;
  }, []));

  // Create `Group` instance for each group and .sortGroup() them again
  out = groups.reduce(function(acc, group) {
    if (group.length <= 1) return acc.concat(group);

    // Remove first predicate
    var pairs = group.map(function(member) {
      return { predicate: member.predicates.shift(), body: member };
    });

    // Pairs all have the same predicate,
    // find pairs with same constant and .sortGroup() them too
    var subgroups = {};
    pairs.forEach(function(pair) {
      var id = pair.predicate.valueId;
      if (!subgroups[id]) {
        subgroups[id] = [ pair ];
      } else {
        subgroups[id].push(pair);
      }
    });

    // Sort group each subgroup again
    pairs = Object.keys(subgroups).reduce(function(acc, key) {
      var subgroup = subgroups[key];
      if (subgroup.length === 0) return acc;

      var predicate = subgroup[0].predicate;
      acc.push({
        predicate: predicate,
        bodies: self.sortGroup(subgroup.map(function(member) {
          return member.body;
        }))
      });

      return acc;
    }, []);

    return acc.concat(new Group(self, pairs));
  }, []);

  return out;
};

Compiler.prototype.render = function render(program, bodyOnly) {
  var stmts = [],
      initializers = program.init.slice(),
      applyBody = program.other.map(function(stmt) {
        return this.replaceThis(stmt);
      }, this),
      apply = {
        type: 'FunctionDeclaration',
        id: { type: 'Identifier', name: 'apply' },
        params: [],
        defaults: [],
        rest: null,
        generator: false,
        expression: false,
        body: {
          type: 'BlockStatement',
          body: [{
            type: 'ReturnStatement',
            argument: {
              type: 'CallExpression',
              callee: { type: 'Identifier', name: 'applyc' },
              arguments: [ { type: 'ThisExpression' } ]
            }
          }]
        }
      },
      applyc = {
        type: 'FunctionDeclaration',
        id: { type: 'Identifier', name: 'applyc' },
        params: [ this.ctx ],
        defaults: [],
        rest: null,
        generator: false,
        expression: false,
        body: {
          type: 'BlockStatement',
          body: null
        }
      };

  // exports.apply = apply
  stmts.push(apply);
  stmts.push({
    type: 'ExpressionStatement',
    expression: {
      type: 'AssignmentExpression',
      operator: '=',
      left: {
        type: 'MemberExpression',
        computed: false,
        object: { type: 'Identifier', name: 'exports' },
        property: { type: 'Identifier', name: 'apply' }
      },
      right: { type: 'Identifier', name: 'apply' }
    }
  });

  // applyc
  stmts.push(applyc);

  // Call applyc once to allow users override exports
  // [init functions].forEach(function(fn) { fn(exports) });
  stmts.push({
    type: 'ExpressionStatement',
    expression: {
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        computed: false,
        property: { type: 'Identifier', name: 'forEach'},
        object: {
          type: 'ArrayExpression',
          elements: initializers
        }
      },
      arguments: [{
        type: 'FunctionExpression',
        id: null,
        params: [{ type: 'Identifier', name: 'fn' }],
        defaults: [],
        rest: null,
        generator: false,
        expression: false,
        body: {
          type: 'BlockStatement',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'CallExpression',
              callee: { type: 'Identifier', name: 'fn' },
              arguments: [{ type: 'Identifier', name: 'exports' }]
            }
          }]
        }
      }]
    }
  });

  // Render each template
  program.templates.forEach(function(template) {
    var ast = template.render();

    /// Apply to the bottom
    if (ast.apply) applyBody = applyBody.concat(ast.apply);

    // Other to the top
    if (ast.other) applyBody = ast.other.concat(applyBody);

    // Initializers to the initializers array
    if (ast.init) {
      if (Array.isArray(ast.init)) {
        initializers.push.apply(initializers, ast.init);
      } else {
        initializers.push(ast.init);
      }
    }
  });

  if (bodyOnly) return applyBody;

  // Set function's body
  applyc.body.body = applyBody;

  return {
    type: 'Program',
    body: stmts
  };
};