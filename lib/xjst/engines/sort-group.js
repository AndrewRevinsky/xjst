var xjst = require('../../xjst'),
    utils = xjst.utils;

module.exports = function traverse(templates) {
  // Sort matches by popularity
  function sort(templates) {
    var chart = {};

    templates.forEach(function(template) {
      template[0].forEach(function(match) {
        var key = match[0];

        if (!chart[key]) chart[key] = 0;
        chart[key]++;
      });
    });

    return templates.map(function(template) {
      return [
        template[0].slice().sort(function(a, b) {
          var rateA = chart[a[0]],
              rateB = chart[b[0]],
              strA = utils.stringify(a[1]),
              strB = utils.stringify(b[1]);

          return rateA > rateB ?
              -1
              :
              rateA === rateB ?
                  strA > strB ? -1 : strA === strB ? 0 : 1 : 1;
        }),
        template[1]
      ];
    });
  }

  var errStmt = ['throw', ['new', 'Error']],
      id = 0;

  // Group matches into switches *recursively*
  function group(templates, state) {
    if (!state) state = {};

    if (templates.length === 0) {
      return {
        id: ++id,
        stmt: errStmt,
        state: utils.clone(state)
      };
    }

    var groups = {},
        tags = [];

    templates.reduce(function(prev, template) {
      var matches = template[0],
          first = matches[0];

      if (!groups[first[0]]) {
        groups[first[0]] = [];
      }

      if (prev === null || prev[0][0][0] !== first[0]) {
        tags.push([first[0], first[1]]);
        groups[first[0]].push({});
      }

      var subGroup = groups[first[0]],
          value = utils.stringify(first[2]);

      // Get latest subgroup
      subGroup = subGroup[subGroup.length - 1];

      if (!subGroup[value]) {
        subGroup[value] = {
          value: first[2],
          items: []
        };
      }

      subGroup[value].items.push([ matches.slice(1), template[1] ]);

      return template;
    }, null);

    var result = { id: ++id, state: utils.clone(state) };
    tags.reduce(function(result, tag) {
      var subgroup = groups[tag[0]].shift();
      result['switch'] = tag[1];

      result.cases = Object.keys(subgroup).map(function(key) {
        var item = subgroup[key];

        // Temporarly change state
        state[utils.stringify(tag[1])] = [item.value];

        // Create sub-switch
        var def = null,
            items = [];

        item.items.every(function(item) {
          if (item[0].length > 0) {
            items.push(item);
            return true;
          } else {
            def = item;
            return false;
          }
        });

        var subSwitch = group(items, state);

        if (subSwitch['switch']) {
          var lastDef = utils.findLastDefault(subSwitch);

          lastDef.id = ++id;
          lastDef.stmt = def ? def[1] : errStmt;
        } else {
          subSwitch.id = ++id;
          subSwitch.stmt = def ? def[1] : errStmt;
        }

        return [item.value, subSwitch];
      });

      result['default'] = {
        id: ++id,
        state: utils.clone(state),
        stmt: errStmt
      };

      return result['default'];
    }, result);

    return result;
  }

  function propagateErrors(tree, handlers) {
    if (!handlers) handlers = [];

    if (tree['switch']) {
      var handler;

      if (tree['default']['switch'] || tree['default'].stmt !== errStmt) {
        handlers.push(handler = tree['default']);
      } else {
        while (handlers.length > 0 &&
               tree === handlers[handlers.length - 1]) {
          handlers.pop();
        }

        if (handlers.length > 0) {
          tree['default'] = handler = handlers[handlers.length - 1];
        }
      }

      tree.cases.forEach(function(c) {
        propagateErrors(c[1], [].concat(handlers));
      });

      while (tree['default'] === handler) {
        handlers.pop();
        handler = handlers[handlers.length - 1];
      }

      propagateErrors(tree['default'], [].concat(handlers));
    }

    return tree;
  }

  // Zip nested matches together (like `this.a && this.a.b`)
  function zip(templates) {
    return templates.map(function(template) {
      var matches = template[0].slice().map(function(match) {
        var pred = match[1];
        while (pred[0] === 'unop' && pred[1] === '!') pred = pred[2];

        return [utils.stringify(pred), match];
      });

      var grouped = [],
          last = matches.reduce(function(prev, curr, i) {
            if (curr[0].indexOf(prev[0]) === -1) {
              grouped.push(prev);
            } else {
              curr = [prev[0], curr[1].concat([prev[1]])];
            }

            return curr;
          });

      if (grouped.indexOf(last) === -1) grouped.push(last);

      return [
        grouped.map(function(match) {
          return match[1];
        }),
        template[1]
      ];
    });
  }

  // Unzip nested templates
  function unzip(templates) {
    return templates.map(function(template) {
      var grouped = [],
          matches = template[0];

      matches.forEach(function unzip(match) {
        if (match[3]) unzip(match[3]);
        grouped.push([match[0], match[1], match[2]]);
      });

      return [
        grouped,
        template[1]
      ];
    });
  }

  return propagateErrors(group(unzip(sort(zip(templates)))));
};